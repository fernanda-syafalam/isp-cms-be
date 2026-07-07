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
 * A private TOTP instance, built the same way `otplib`'s exported
 * `authenticator` singleton is (same crypto + base32 plugins — see
 * `@otplib/preset-default`), but constructed locally instead of imported.
 * `otplib`'s classic API only exposes that singleton (mutating it via
 * `authenticator.options = {...}` is a module-load side effect any other
 * importer could also perturb — F7), so we build our own instance here
 * and never touch the shared one. `window: 1` tolerates one step (30s)
 * of clock skew on either side of "now" for every verification in this
 * service; F5 (`TotpReplayGuardService`) is what keeps an already-spent
 * code inside that window from being reusable.
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

  /**
   * `currentSessionId` comes from the caller's JWT `sid` claim
   * (`AuthUser.sessionId`) — undefined for a pre-SEC-2 access token, in
   * which case no row is marked `current` rather than guessing wrong.
   */
  async getState(userId: string, currentSessionId?: string): Promise<SecurityStateResponse> {
    await this.repo.ensureState(userId);
    return this.buildState(userId, currentSessionId);
  }

  /**
   * Step 1 of 2: generate a fresh TOTP secret, persist it, and hand back
   * the otpauth URI (for a QR code) + the raw base32 secret (manual entry
   * fallback). `twoFactorEnabled` is left false — a stored-but-unconfirmed
   * secret must never gate login. Re-callable: starting over discards any
   * previous unconfirmed secret.
   */
  async beginEnroll(userId: string, accountName: string): Promise<TwoFactorEnrollResponse> {
    await this.repo.ensureState(userId);
    const secret = authenticator.generateSecret();
    // F2: only the encrypted blob is persisted — the plaintext base32
    // secret returned below (for the QR code / manual entry) never
    // touches the DB.
    await this.repo.saveTwoFactorSecret(userId, this.cipher.encrypt(secret));
    this.logger.log({ userId }, 'two-factor enrollment started');
    return {
      twoFactorSecret: secret,
      otpauthUri: authenticator.keyuri(accountName, TOTP_ISSUER, secret),
    };
  }

  /**
   * Step 2 of 2: verify the code the user just read off their
   * authenticator app against the secret stored by `beginEnroll`. Only on
   * success does `twoFactorEnabled` flip to true.
   *
   * F1: gated by the same per-user brute-force lockout as the login
   * challenge — a stolen/guessed-at unconfirmed secret cannot be brute
   * forced here either.
   *
   * F3: on success, revokes every OTHER active session for this user —
   * enabling 2FA is frequently a direct response to "I think my account
   * is compromised", so the moment it succeeds is exactly when a
   * session hijacked before 2FA was on should be kicked out, not left
   * to ride out its own TTL. `currentSessionId` (the caller's own
   * session, from the JWT `sid` claim) is kept alive.
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
    // F2: decrypt only after the lockout gate, same as every other check
    // in this service. A decrypt failure (legacy plaintext / corrupted
    // blob) is an anomaly, not the caller's fault — fail closed without
    // spending one of their lockout attempts on it.
    const secret = this.decryptSecretOrWarn(userId, state.twoFactorSecret);
    if (!secret) {
      throw new UnauthorizedException('invalid two-factor authentication code');
    }
    const result = await this.checkCode(userId, code, secret);
    if (result !== 'ok') {
      // F5: a replay is still a rejected attempt from the caller's point
      // of view, but (like a decrypt failure) it does not count against
      // the brute-force lockout — it is the user's own code re-submitted,
      // not a guess.
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
   * Requires a valid current TOTP code only when 2FA is actually enabled —
   * an in-progress, never-confirmed enrollment (secret present, flag
   * false) can be cancelled without one since it was never gating login.
   * F1: the same lockout as login/confirm applies to that code check.
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
      // F2: unlike `confirmEnroll`/`verifyLoginChallenge`, a missing secret
      // already counted as a failed attempt here before F2 landed (the
      // pre-existing `||` chain below) — a decrypt failure is folded into
      // that same, already-established behavior rather than carving out a
      // new "free" branch for it.
      const secret = state.twoFactorSecret
        ? this.decryptSecretOrWarn(userId, state.twoFactorSecret)
        : null;
      const result = code && secret ? await this.checkCode(userId, code, secret) : 'invalid';
      if (result !== 'ok') {
        // F5: same rationale as `confirmEnroll` — a replay doesn't burn a
        // lockout attempt, only a genuinely wrong/missing/undecryptable
        // code does.
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
   * Called by AuthService during login — never by the security controller.
   * Returns 'ok' when the user has no confirmed 2FA, or the supplied code
   * checks out; 'required' when 2FA is on and no code was submitted;
   * 'invalid' when a submitted code fails verification; 'locked' when
   * the account has hit the brute-force threshold (F1) and is still
   * within its lockout window — checked *before* verifying the code, so
   * a lockout also blocks an otherwise-correct code. Deliberately
   * returns a discriminated result instead of throwing so AuthService
   * (not this module) decides the HTTP-facing error shape.
   */
  async verifyLoginChallenge(userId: string, code?: string): Promise<LoginChallengeResult> {
    const state = await this.repo.findState(userId);
    if (!state?.twoFactorEnabled) return 'ok';
    if (!code) return 'required';
    // Defensive: `twoFactorEnabled` should never be true without a secret
    // (confirmTwoFactor only runs after a secret-backed check succeeds).
    // Fail CLOSED, not open — an anomalous enabled-but-no-secret row must
    // never let a login through un-challenged. There is nothing to verify
    // the submitted code against, so treat it as invalid. Not counted
    // against the lockout — there is no secret to have brute-forced.
    if (!state.twoFactorSecret) return 'invalid';
    if (await this.lockout.isLocked(userId)) return 'locked';
    // F2: same fail-closed-without-a-lockout-penalty treatment as the
    // "no secret" branch above — a decrypt failure (legacy plaintext /
    // corrupted blob) is an anomaly the user didn't cause.
    const secret = this.decryptSecretOrWarn(userId, state.twoFactorSecret);
    if (!secret) return 'invalid';
    const result = await this.checkCode(userId, code, secret);
    if (result === 'replay') {
      // F5: the user's own code re-submitted, not a guess — don't spend
      // one of their lockout attempts on it, but still refuse the login.
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

  /**
   * Revoke exactly one session, backed by the real refresh-token store
   * (SEC-2) — the underlying token is deleted from Redis, not just a
   * display row, so a stolen refresh token actually stops working.
   */
  async revokeSession(userId: string, id: string): Promise<void> {
    const existed = await this.sessions.revokeSession(userId, id);
    if (!existed) throw new NotFoundException('session not found');
    this.logger.log({ userId, sessionId: id }, 'session revoked');
  }

  /**
   * "End all other sessions" — revokes every session for `userId` except
   * `currentSessionId` (the caller's own, from the JWT `sid` claim).
   */
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
   * F2: decrypt a stored secret, logging (without the value, key, or code)
   * and returning `null` instead of throwing when it isn't in the
   * `iv:authTag:ciphertext` shape `TotpSecretCipherService` produces —
   * either a pre-F2 plaintext secret or a corrupted blob. Every call site
   * treats a `null` return the same way it already treats a genuinely
   * missing secret: fail the challenge closed, never crash, never let it
   * through as valid.
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
   * F5: matches `code` against `secret` (already decrypted) and enforces
   * the replay guard in one place, shared by every call site that checks
   * a TOTP code. `checkDelta` (not `check`) is used so the exact matched
   * step — which may be the step before/after "now" thanks to
   * `window: 1` — can be compared against the last accepted step for
   * this user, rather than only knowing "some step in the window
   * matched".
   */
  private async checkCode(userId: string, code: string, secret: string): Promise<CodeCheckResult> {
    const delta = authenticator.checkDelta(code, secret);
    if (delta === null) return 'invalid';
    const { step } = authenticator.allOptions();
    // Same formula `@otplib/core` uses internally (`totpCounter`), so the
    // step this computes for delta === 0 always matches what otplib just
    // matched against.
    const matchedStep = Math.floor(Date.now() / step / 1000) + delta;
    const lastAccepted = await this.replayGuard.getLastAcceptedStep(userId);
    if (lastAccepted !== null && matchedStep <= lastAccepted) {
      return 'replay';
    }
    await this.replayGuard.recordAcceptedStep(userId, matchedStep);
    return 'ok';
  }
}

/**
 * Maps a real Redis-backed session onto the FE-facing shape. `device` is
 * the raw `User-Agent` string — there is no client-side device/browser
 * parsing implemented, so this is the most specific value that is both
 * real (not invented) and available; a friendlier "Chrome on Windows"
 * label is a FE-side (or future BE `ua-parser`) presentation concern, not
 * a security-relevant value like a fabricated location would be.
 */
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
