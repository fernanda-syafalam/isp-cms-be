import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Authenticator } from '@otplib/core';
import { createDigest, createRandomBytes } from '@otplib/plugin-crypto';
import { keyDecoder, keyEncoder } from '@otplib/plugin-thirty-two';
import type { SessionSummary } from '../sessions/refresh-token.service';
import { RefreshTokenService } from '../sessions/refresh-token.service';
import type { SecuritySessionResponse, SecurityStateResponse } from './dto/security-response.dto';
import type { TwoFactorEnrollResponse } from './dto/two-factor-enroll-response.dto';
import { SecurityRepository } from './security.repository';
import { TotpLockoutService } from './totp-lockout.service';
import { TotpReplayGuardService } from './totp-replay-guard.service';
import { TotpSecretCipherService } from './totp-secret-cipher.service';

/** The issuer label shown in the authenticator app next to the account name. */
const TOTP_ISSUER = 'ISP CMS';

/**
 * Private TOTP instance: mutating otplib's shared `authenticator` singleton
 * is a global side effect other importers could perturb (F7). `window: 1`
 * tolerates one step (30s) of clock skew either side; F5
 * (`TotpReplayGuardService`) stops a spent code being reused in that window.
 */
const authenticator = new Authenticator({
  createDigest,
  createRandomBytes,
  keyDecoder,
  keyEncoder,
  window: 1,
});

/** Outcome of checking a login attempt against the user's 2FA state. */
export type LoginChallengeResult = 'ok' | 'required' | 'invalid' | 'locked';

/** Outcome of matching a code against a (decrypted) secret, before the caller reacts. */
type CodeCheckResult =
  | 'ok'
  /** Wrong code, or `checkDelta` found no matching step in the window. */
  | 'invalid'
  /** A structurally valid code, but for a step already accepted before (F5). */
  | 'replay';

const LOCKOUT_MESSAGE = 'too many failed two-factor attempts — try again later';

@Injectable()
export class SecurityService {
  private readonly logger = new Logger(SecurityService.name);

  constructor(
    private readonly repo: SecurityRepository,
    private readonly lockout: TotpLockoutService,
    private readonly sessions: RefreshTokenService,
    private readonly cipher: TotpSecretCipherService,
    private readonly replayGuard: TotpReplayGuardService,
  ) {}

  /** `currentSessionId` is the JWT `sid` claim; undefined (pre-SEC-2 token) marks no row `current`. */
  async getState(userId: string, currentSessionId?: string): Promise<SecurityStateResponse> {
    await this.repo.ensureState(userId);
    return this.buildState(userId, currentSessionId);
  }

  /**
   * Step 1 of 2: persist a fresh secret and return the otpauth URI + raw base32.
   * `twoFactorEnabled` stays false — an unconfirmed secret must never gate
   * login. Re-callable: discards any previous unconfirmed secret.
   */
  async beginEnroll(userId: string, accountName: string): Promise<TwoFactorEnrollResponse> {
    await this.repo.ensureState(userId);
    const secret = authenticator.generateSecret();
    // F2: only the encrypted blob is persisted; the plaintext never touches the DB.
    await this.repo.saveTwoFactorSecret(userId, this.cipher.encrypt(secret));
    this.logger.log({ userId }, 'two-factor enrollment started');
    return {
      twoFactorSecret: secret,
      otpauthUri: authenticator.keyuri(accountName, TOTP_ISSUER, secret),
    };
  }

  /**
   * Step 2 of 2: verify the code against the secret from `beginEnroll`; only
   * success flips `twoFactorEnabled`.
   *
   * F1: same brute-force lockout as login.
   * F3: on success revokes every OTHER session — enabling 2FA is often a
   * response to suspected compromise, so a pre-2FA hijacked session must not
   * survive. The caller's own session is kept.
   */
  async confirmEnroll(
    userId: string,
    code: string,
    currentSessionId?: string,
  ): Promise<SecurityStateResponse> {
    await this.repo.ensureState(userId);
    const state = await this.repo.findState(userId);
    if (!state?.twoFactorSecret) {
      throw new BadRequestException('two-factor enrollment was not started');
    }
    if (await this.lockout.isLocked(userId)) {
      throw new UnauthorizedException({ message: LOCKOUT_MESSAGE, code: 'totp_locked' });
    }
    // F2: decrypt after the lockout gate. A decrypt failure is an anomaly, not
    // the caller's fault — fail closed without spending a lockout attempt.
    const secret = this.decryptSecretOrWarn(userId, state.twoFactorSecret);
    if (!secret) {
      throw new UnauthorizedException('invalid two-factor authentication code');
    }
    const result = await this.checkCode(userId, code, secret);
    if (result !== 'ok') {
      // F5: a replay is the user's own code re-submitted, not a guess — rejected
      // but not counted against the lockout.
      if (result === 'invalid') await this.lockout.recordFailure(userId);
      throw new UnauthorizedException('invalid two-factor authentication code');
    }
    await this.lockout.recordSuccess(userId);
    await this.repo.confirmTwoFactor(userId);
    const revoked = await this.sessions.revokeOtherSessions(userId, currentSessionId);
    this.logger.log({ userId, revokedOtherSessions: revoked }, 'two-factor enabled');
    return this.buildState(userId, currentSessionId);
  }

  /**
   * Requires a TOTP code only when 2FA is enabled; an unconfirmed enrollment
   * never gated login, so it is cancelled without one. F1: same lockout applies.
   */
  async disableTwoFactor(
    userId: string,
    code?: string,
    currentSessionId?: string,
  ): Promise<SecurityStateResponse> {
    await this.repo.ensureState(userId);
    const state = await this.repo.findState(userId);
    if (state?.twoFactorEnabled) {
      if (await this.lockout.isLocked(userId)) {
        throw new UnauthorizedException({ message: LOCKOUT_MESSAGE, code: 'totp_locked' });
      }
      // F2: unlike the other paths, a missing or undecryptable secret counts
      // as a failed attempt here (established behavior).
      const secret = state.twoFactorSecret
        ? this.decryptSecretOrWarn(userId, state.twoFactorSecret)
        : null;
      const result = code && secret ? await this.checkCode(userId, code, secret) : 'invalid';
      if (result !== 'ok') {
        // F5: as in `confirmEnroll`, a replay does not burn a lockout attempt.
        if (result === 'invalid') await this.lockout.recordFailure(userId);
        throw new UnauthorizedException('invalid two-factor authentication code');
      }
      await this.lockout.recordSuccess(userId);
    }
    await this.repo.clearTwoFactor(userId);
    this.logger.log({ userId }, 'two-factor disabled');
    return this.buildState(userId, currentSessionId);
  }

  /**
   * Called by AuthService at login. Lockout (F1) is checked before the code,
   * so it also blocks a correct code. Returns a result instead of throwing so
   * AuthService decides the HTTP error shape.
   */
  async verifyLoginChallenge(userId: string, code?: string): Promise<LoginChallengeResult> {
    const state = await this.repo.findState(userId);
    if (!state?.twoFactorEnabled) return 'ok';
    if (!code) return 'required';
    // Enabled-but-no-secret is anomalous: fail CLOSED so login is never
    // un-challenged. Not counted against the lockout (nothing to brute-force).
    if (!state.twoFactorSecret) return 'invalid';
    if (await this.lockout.isLocked(userId)) return 'locked';
    // F2: decrypt failure fails closed without a lockout penalty (not the user's doing).
    const secret = this.decryptSecretOrWarn(userId, state.twoFactorSecret);
    if (!secret) return 'invalid';
    const result = await this.checkCode(userId, code, secret);
    if (result === 'replay') {
      // F5: own code re-submitted, not a guess — refuse without a lockout attempt.
      this.logger.warn({ userId }, 'rejected a replayed two-factor code at login');
      return 'invalid';
    }
    if (result === 'invalid') {
      await this.lockout.recordFailure(userId);
      return 'invalid';
    }
    await this.lockout.recordSuccess(userId);
    return 'ok';
  }

  /** Revokes one session; the refresh token is deleted (SEC-2), so a stolen one stops working. */
  async revokeSession(userId: string, id: string): Promise<void> {
    const existed = await this.sessions.revokeSession(userId, id);
    if (!existed) throw new NotFoundException('session not found');
    this.logger.log({ userId, sessionId: id }, 'session revoked');
  }

  /** Revokes every session except `currentSessionId` (see RefreshTokenService). */
  async revokeOtherSessions(userId: string, currentSessionId?: string): Promise<void> {
    const revoked = await this.sessions.revokeOtherSessions(userId, currentSessionId);
    this.logger.log({ userId, revoked }, 'other sessions revoked');
  }

  private async buildState(
    userId: string,
    currentSessionId: string | undefined,
  ): Promise<SecurityStateResponse> {
    const state = await this.repo.findState(userId);
    const sessions = await this.sessions.listSessions(userId);
    return {
      twoFactorEnabled: state?.twoFactorEnabled ?? false,
      sessions: sessions.map((s) => toSessionResponse(s, currentSessionId)),
    };
  }

  /**
   * F2: decrypts a stored secret; returns `null` (logged without value, key
   * or code) for a legacy plaintext or corrupted blob. Callers treat `null`
   * like a missing secret: fail closed, never crash, never valid.
   */
  private decryptSecretOrWarn(userId: string, stored: string): string | null {
    const plain = this.cipher.decrypt(stored);
    if (plain === null) {
      this.logger.warn(
        { userId },
        'stored two-factor secret failed to decrypt — treating as unverifiable',
      );
    }
    return plain;
  }

  /**
   * F5: matches `code` and enforces the replay guard. `checkDelta` yields the
   * exact matched step (may be +/-1 from now). Compare-and-record is one
   * atomic `acceptStep`; a separate read-then-write would race.
   */
  private async checkCode(userId: string, code: string, secret: string): Promise<CodeCheckResult> {
    const delta = authenticator.checkDelta(code, secret);
    if (delta === null) return 'invalid';
    const { step } = authenticator.allOptions();
    // Same formula as `@otplib/core`'s `totpCounter`.
    const matchedStep = Math.floor(Date.now() / step / 1000) + delta;
    const accepted = await this.replayGuard.acceptStep(userId, matchedStep);
    return accepted ? 'ok' : 'replay';
  }
}

/** Maps a session to the FE shape. `device` is the raw `User-Agent`; friendlier labels are a FE concern. */
function toSessionResponse(
  session: SessionSummary,
  currentSessionId: string | undefined,
): SecuritySessionResponse {
  return {
    id: session.id,
    device: session.userAgent,
    ip: session.ip,
    lastActiveAt: session.lastUsedAt,
    current: session.id === currentSessionId,
  };
}
