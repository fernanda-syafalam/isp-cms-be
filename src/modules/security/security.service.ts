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
import type {
  NewUserSession,
  UserSession,
} from '../../infrastructure/database/schema/security.schema';
import type { SecuritySessionResponse, SecurityStateResponse } from './dto/security-response.dto';
import type { TwoFactorEnrollResponse } from './dto/two-factor-enroll-response.dto';
import { SecurityRepository } from './security.repository';
import { TotpLockoutService } from './totp-lockout.service';

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
 * service. v1 accepts any code inside that window, including one already
 * spent (no single-use replay tracking yet) — noted as a follow-up in
 * the PR description.
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

const LOCKOUT_MESSAGE = 'too many failed two-factor attempts — try again later';

@Injectable()
export class SecurityService {
  private readonly logger = new Logger(SecurityService.name);

  constructor(
    private readonly repo: SecurityRepository,
    private readonly lockout: TotpLockoutService,
  ) {}

  async getState(userId: string): Promise<SecurityStateResponse> {
    await this.ensureSeeded(userId);
    return this.buildState(userId);
  }

  /**
   * Step 1 of 2: generate a fresh TOTP secret, persist it, and hand back
   * the otpauth URI (for a QR code) + the raw base32 secret (manual entry
   * fallback). `twoFactorEnabled` is left false — a stored-but-unconfirmed
   * secret must never gate login. Re-callable: starting over discards any
   * previous unconfirmed secret.
   */
  async beginEnroll(userId: string, accountName: string): Promise<TwoFactorEnrollResponse> {
    await this.ensureSeeded(userId);
    const secret = authenticator.generateSecret();
    await this.repo.saveTwoFactorSecret(userId, secret);
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
   */
  async confirmEnroll(userId: string, code: string): Promise<SecurityStateResponse> {
    await this.ensureSeeded(userId);
    const state = await this.repo.findState(userId);
    if (!state?.twoFactorSecret) {
      throw new BadRequestException('two-factor enrollment was not started');
    }
    if (await this.lockout.isLocked(userId)) {
      throw new UnauthorizedException({ message: LOCKOUT_MESSAGE, code: 'totp_locked' });
    }
    if (!authenticator.check(code, state.twoFactorSecret)) {
      await this.lockout.recordFailure(userId);
      throw new UnauthorizedException('invalid two-factor authentication code');
    }
    await this.lockout.recordSuccess(userId);
    await this.repo.confirmTwoFactor(userId);
    this.logger.log({ userId }, 'two-factor enabled');
    return this.buildState(userId);
  }

  /**
   * Requires a valid current TOTP code only when 2FA is actually enabled —
   * an in-progress, never-confirmed enrollment (secret present, flag
   * false) can be cancelled without one since it was never gating login.
   * F1: the same lockout as login/confirm applies to that code check.
   */
  async disableTwoFactor(userId: string, code?: string): Promise<SecurityStateResponse> {
    await this.ensureSeeded(userId);
    const state = await this.repo.findState(userId);
    if (state?.twoFactorEnabled) {
      if (await this.lockout.isLocked(userId)) {
        throw new UnauthorizedException({ message: LOCKOUT_MESSAGE, code: 'totp_locked' });
      }
      if (!code || !state.twoFactorSecret || !authenticator.check(code, state.twoFactorSecret)) {
        await this.lockout.recordFailure(userId);
        throw new UnauthorizedException('invalid two-factor authentication code');
      }
      await this.lockout.recordSuccess(userId);
    }
    await this.repo.clearTwoFactor(userId);
    this.logger.log({ userId }, 'two-factor disabled');
    return this.buildState(userId);
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
    if (!authenticator.check(code, state.twoFactorSecret)) {
      await this.lockout.recordFailure(userId);
      return 'invalid';
    }
    await this.lockout.recordSuccess(userId);
    return 'ok';
  }

  async revokeSession(userId: string, id: string): Promise<void> {
    const deleted = await this.repo.deleteSession(id, userId);
    if (!deleted) throw new NotFoundException('session not found');
    this.logger.log({ userId, sessionId: id }, 'session revoked');
  }

  async revokeOtherSessions(userId: string): Promise<void> {
    await this.repo.deleteOtherSessions(userId);
    this.logger.log({ userId }, 'other sessions revoked');
  }

  // Seed the per-user state + a representative session list on first access.
  private async ensureSeeded(userId: string): Promise<void> {
    await this.repo.ensureState(userId);
    if ((await this.repo.countSessions(userId)) === 0) {
      await this.repo.seedSessions(buildSeedSessions(userId));
    }
  }

  private async buildState(userId: string): Promise<SecurityStateResponse> {
    const state = await this.repo.findState(userId);
    const sessions = await this.repo.listSessions(userId);
    return {
      twoFactorEnabled: state?.twoFactorEnabled ?? false,
      sessions: sessions.map(toSessionResponse),
    };
  }
}

function buildSeedSessions(userId: string): NewUserSession[] {
  return [
    { userId, device: 'Chrome di Windows', ip: '103.28.12.4', isCurrent: true },
    { userId, device: 'Safari di iPhone', ip: '103.28.12.9', isCurrent: false },
  ];
}

function toSessionResponse(row: UserSession): SecuritySessionResponse {
  return {
    id: row.id,
    device: row.device,
    ip: row.ip,
    lastActiveAt: row.lastActiveAt.toISOString(),
    current: row.isCurrent,
  };
}
