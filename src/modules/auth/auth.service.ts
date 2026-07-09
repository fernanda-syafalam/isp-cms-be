import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { notifyBestEffort } from '../../common/notifications/notify-best-effort';
import type { NewAuditLogEntry } from '../../infrastructure/database/schema/audit.schema';
import { AuditRepository } from '../audit/audit.repository';
import { SecurityService } from '../security/security.service';
import type { SessionMeta } from '../sessions/refresh-token.service';
import { RefreshTokenService } from '../sessions/refresh-token.service';
import { UsersRepository } from '../users/users.repository';
import { UsersService } from '../users/users.service';
import type { BootstrapInput } from './dto/bootstrap.dto';

interface JwtPayload {
  sub: string;
  role: AuthUser['role'];
  // SEC-2: which session (see RefreshTokenService) this access token
  // belongs to — lets any authenticated request identify "its own"
  // session without the refresh cookie, which is scoped to /v1/auth only.
  sid: string;
}

/**
 * Internal result carrying both the access token and the raw refresh
 * token + TTL so the controller can set the httpOnly cookie. Neither
 * `refreshToken` nor `refreshExpiresInSeconds` is ever sent in the
 * JSON body — the controller extracts them before building the response.
 */
export interface LoginResult {
  accessToken: string;
  /** Raw opaque refresh token — MUST be placed in httpOnly cookie, not JSON body. */
  refreshToken: string;
  refreshExpiresInSeconds: number;
  user: AuthUser;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersRepo: UsersRepository,
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly security: SecurityService,
    // R8-OBS-2: injected directly (not via AuditInterceptor) because these
    // three events need to distinguish success from several failure reasons,
    // and the failure path here never reaches a 2xx the interceptor keys on.
    // AuditModule is @Global(), so no extra module import is required.
    private readonly auditRepo: AuditRepository,
  ) {}

  /** True only when no user exists yet — the first-run bootstrap window. */
  async bootstrapRequired(): Promise<boolean> {
    return (await this.users.count()) === 0;
  }

  /**
   * Create the first admin (empty-table only) and immediately log them in —
   * returns a LoginResult so the controller sets the refresh cookie exactly
   * like login(). Throws 409 once any user exists (single-use). Role is forced
   * to 'admin' inside UsersService; the empty-check + insert are serialized by
   * an advisory lock so concurrent bootstrap attempts cannot both succeed.
   */
  async bootstrapAdmin(input: BootstrapInput, meta: SessionMeta): Promise<LoginResult> {
    const user = await this.users.bootstrapAdmin(input);
    if (!user) {
      throw new ConflictException('bootstrap already completed');
    }
    const refresh = await this.refreshTokens.mint(user.id, meta);
    const accessToken = await this.signAccess(user.id, user.role, refresh.sessionId);
    return {
      accessToken,
      refreshToken: refresh.token,
      refreshExpiresInSeconds: refresh.expiresInSeconds,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        resellerId: user.resellerId,
      },
    };
  }

  /**
   * `totpCode` is optional and only consulted once the password has
   * already checked out (Pilar: never leak "you'd need a 2FA code" to an
   * attacker guessing passwords). ADR-0002 documents the error markers
   * this can throw: `totp_required` (2FA on, no/blank code sent — client
   * should prompt), `totp_invalid` (2FA on, code sent but wrong), and
   * `totp_locked` (F1 brute-force lockout — 5 consecutive failures blocks
   * further attempts, correct code included, for ~15 minutes). No token
   * is issued in any of the three cases.
   */
  async login(
    email: string,
    password: string,
    totpCode: string | undefined,
    meta: SessionMeta,
  ): Promise<LoginResult> {
    const user = await this.usersRepo.findByEmail(email);
    // Same response shape for "user not found" and "password mismatch"
    // so an attacker cannot enumerate registered emails through timing
    // or message differences.
    const fakeHash = '$argon2id$v=19$m=19456,t=2,p=1$placeholder$invalid';
    const passwordOk = await argon2
      .verify(user?.passwordHash ?? fakeHash, password)
      .catch(() => false);
    if (!user || !passwordOk) {
      // R8-OBS-2: audited under the SAME 'invalid_credentials' reason for
      // both "no such user" and "wrong password" — do not let the audit
      // trail leak the enumeration signal the response body already hides.
      await this.recordLoginAudit(email, 'failure', 'invalid_credentials', meta);
      throw new UnauthorizedException('invalid credentials');
    }

    const challenge = await this.security.verifyLoginChallenge(user.id, totpCode);
    if (challenge === 'required') {
      await this.recordLoginAudit(email, 'failure', 'totp_required', meta, user.id);
      throw new UnauthorizedException({
        message: 'two-factor authentication code required',
        code: 'totp_required',
      });
    }
    if (challenge === 'invalid') {
      await this.recordLoginAudit(email, 'failure', 'totp_invalid', meta, user.id);
      throw new UnauthorizedException({
        message: 'invalid two-factor authentication code',
        code: 'totp_invalid',
      });
    }
    if (challenge === 'locked') {
      await this.recordLoginAudit(email, 'failure', 'totp_locked', meta, user.id);
      throw new UnauthorizedException({
        message: 'too many failed two-factor attempts — try again later',
        code: 'totp_locked',
      });
    }

    const refresh = await this.refreshTokens.mint(user.id, meta);
    const accessToken = await this.signAccess(user.id, user.role, refresh.sessionId);
    await this.recordLoginAudit(email, 'success', 'ok', meta, user.id);
    return {
      accessToken,
      refreshToken: refresh.token,
      refreshExpiresInSeconds: refresh.expiresInSeconds,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        resellerId: user.resellerId,
      },
    };
  }

  /**
   * Trade a refresh token for a fresh pair. The old refresh token is
   * single-use (rotated) so a leaked token has at most one replay
   * window before the next legitimate refresh invalidates it. The
   * session id stays the same across rotation (SEC-2) — only `ip`/
   * `userAgent` on the session record are refreshed from `meta`.
   */
  async refresh(rawRefreshToken: string, meta: SessionMeta): Promise<LoginResult> {
    const { userId, refresh } = await this.refreshTokens.rotate(rawRefreshToken, meta);
    const user = await this.usersRepo.findById(userId);
    if (!user) {
      // User got deleted between issuance and refresh; treat as logged out.
      throw new UnauthorizedException('invalid refresh token');
    }
    const accessToken = await this.signAccess(user.id, user.role, refresh.sessionId);
    await this.recordAudit({
      actor: user.id,
      action: 'auth.refresh',
      entity: 'auth',
      entityId: user.id,
      summary: `auth.refresh success (ip=${meta.ip})`,
    });
    return {
      accessToken,
      refreshToken: refresh.token,
      refreshExpiresInSeconds: refresh.expiresInSeconds,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        resellerId: user.resellerId,
      },
    };
  }

  async logout(rawRefreshToken: string, meta: SessionMeta): Promise<void> {
    const revoked = await this.refreshTokens.revoke(rawRefreshToken);
    // NOT NULL actor column — an unknown/already-rotated token resolves no
    // userId, same 'system' fallback AuditInterceptor uses for public routes.
    await this.recordAudit({
      actor: revoked?.userId ?? 'system',
      action: 'auth.logout',
      entity: 'auth',
      entityId: revoked?.userId,
      summary: revoked
        ? `auth.logout success (ip=${meta.ip})`
        : `auth.logout no-op: unknown or already-revoked token (ip=${meta.ip})`,
    });
  }

  private async signAccess(
    userId: string,
    role: AuthUser['role'],
    sessionId: string,
  ): Promise<string> {
    const payload: JwtPayload = { sub: userId, role, sid: sessionId };
    return this.jwt.signAsync(payload);
  }

  /**
   * R8-OBS-2: `auth.login`'s single audit entry point — success and every
   * distinguishable failure reason funnel through here so the shape can
   * never drift between branches. `actor` is the submitted email (the
   * forensic identity for a login event, including failed ones where no
   * user id may exist) — never a field named `email`/`phone`, which the
   * pino redact rules strip; `actor` is exempt and stays visible.
   * `entityId` is the resolved user id when known (unknown-email failures
   * have none — that branch is exactly what anti-enumeration protects).
   */
  private async recordLoginAudit(
    email: string,
    outcome: 'success' | 'failure',
    reason: 'ok' | 'invalid_credentials' | 'totp_required' | 'totp_invalid' | 'totp_locked',
    meta: SessionMeta,
    userId?: string,
  ): Promise<void> {
    await this.recordAudit({
      actor: email,
      action: 'auth.login',
      entity: 'auth',
      entityId: userId,
      summary: `auth.login ${outcome}: ${reason} (ip=${meta.ip})`,
    });
  }

  /**
   * Fire this from a `catch`-free `await` (never `void`-and-forget) so
   * ordering in tests is deterministic, but never let a broken audit write
   * fail the auth flow that already succeeded/failed on its own terms —
   * mirrors `notifyBestEffort`'s resilience contract (ADR-0012).
   */
  private async recordAudit(entry: NewAuditLogEntry): Promise<void> {
    await notifyBestEffort(
      this.logger,
      () => this.auditRepo.record(entry),
      { action: entry.action, entity: entry.entity },
      'audit persist failed',
    );
  }
}
