import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AnyAuthenticatedRole } from '../../common/decorators/any-authenticated-role.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { SessionMeta } from '../sessions/refresh-token.service';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { BootstrapDto } from './dto/bootstrap.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';

/** @fastify/cookie augments FastifyRequest with a `cookies` record after plugin registration. */
type CookieRequest = FastifyRequest & { cookies: Record<string, string | undefined> };

const REFRESH_COOKIE = 'refresh_token';
const COOKIE_PATH = '/v1/auth';

/**
 * Captures the request metadata a freshly minted session is tagged with
 * (SEC-2) — the `userAgent`/`ip` shown back on the security page's
 * session list. `req.ip` honours the bounded `trustProxy` setting (main.ts,
 * default 1 hop) — behind the single ingress it is the real client IP, not a
 * spoofable X-Forwarded-For value.
 */
function sessionMetaFrom(req: FastifyRequest): SessionMeta {
  const ua = req.headers['user-agent'];
  return {
    userAgent: (Array.isArray(ua) ? ua[0] : ua) ?? 'unknown',
    ip: req.ip,
  };
}

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  // F1: stricter than the global per-IP limit — login is also gated by
  // the per-user TOTP lockout (TotpLockoutService) once 2FA is on, but
  // this caps raw login attempts (password guessing) regardless of 2FA.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ accessToken: string; user: AuthUser }> {
    const result = await this.auth.login(
      body.email,
      body.password,
      body.totpCode,
      sessionMetaFrom(req),
    );
    this.setRefreshCookie(reply, result.refreshToken, result.refreshExpiresInSeconds);
    return { accessToken: result.accessToken, user: result.user };
  }

  /**
   * Exchange a still-valid refresh token for a fresh access + refresh
   * pair. The previous refresh token is rotated (single-use) — a stolen
   * token has at most one replay window before the next legitimate
   * refresh invalidates it. Token is read from the httpOnly cookie, not
   * the request body (ADR-0002 / browser SPA cookie model).
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: CookieRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ accessToken: string; user: AuthUser }> {
    const rawToken = req.cookies[REFRESH_COOKIE];
    if (!rawToken) {
      throw new UnauthorizedException('refresh token cookie missing');
    }
    const result = await this.auth.refresh(rawToken, sessionMetaFrom(req));
    this.setRefreshCookie(reply, result.refreshToken, result.refreshExpiresInSeconds);
    return { accessToken: result.accessToken, user: result.user };
  }

  /**
   * Best-effort logout — drops the refresh token from Redis and clears
   * the httpOnly cookie. The access token (JWT) remains valid until its
   * own TTL; the SPA should also drop it from memory.
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() req: CookieRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const rawToken = req.cookies[REFRESH_COOKIE];
    if (rawToken) {
      await this.auth.logout(rawToken, sessionMetaFrom(req));
    }
    // Clear regardless — idempotent for the browser.
    reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
  }

  /**
   * First-run probe — reports whether the instance still has zero users and
   * therefore needs the one-time bootstrap admin flow. Public so the login/
   * bootstrap screens can route on it before any credential exists.
   */
  @Public()
  @Get('bootstrap')
  async bootstrapStatus(): Promise<{ required: boolean }> {
    return { required: await this.auth.bootstrapRequired() };
  }

  /**
   * One-time first-run create-admin. Only succeeds while the users table is
   * empty (409 afterwards) and forces role='admin' server-side. On success the
   * new admin is logged in immediately (refresh cookie + access token), exactly
   * like login — so a fresh install goes straight to an authenticated session.
   */
  @Public()
  @Audit('auth.bootstrap')
  @Post('bootstrap')
  @HttpCode(HttpStatus.CREATED)
  async bootstrap(
    @Body() body: BootstrapDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ accessToken: string; user: AuthUser }> {
    const result = await this.auth.bootstrapAdmin(body, sessionMetaFrom(req));
    this.setRefreshCookie(reply, result.refreshToken, result.refreshExpiresInSeconds);
    return { accessToken: result.accessToken, user: result.user };
  }

  /**
   * Lightweight identity probe — confirms the bearer token resolves to
   * a known user. Useful as a smoke test for clients and as a working
   * example of the `@CurrentUser` decorator.
   */
  @AnyAuthenticatedRole()
  @Get('me')
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  /**
   * Self-service credential rotation (P1.4) — any authenticated role.
   * Requires the current password so a hijacked session cannot rotate
   * the credential. Existing refresh tokens stay valid until their own
   * rotation/TTL (single-use); a compromised session is cut by logout.
   */
  @AnyAuthenticatedRole()
  // R5-SEC-2: tighten beyond the global 100/window — the handler re-checks the
  // CURRENT password, so an attacker holding a stolen access token could
  // otherwise brute-force it. Mirrors the login route's tight throttle.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Audit('auth.change_password')
  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() body: ChangePasswordDto,
  ): Promise<void> {
    await this.users.changePassword(user.id, body.currentPassword, body.newPassword);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private setRefreshCookie(reply: FastifyReply, token: string, maxAge: number): void {
    // secure / sameSite / domain come from the plugin defaults registered
    // in main.ts (fastifyCookie({ defaults: { ... } })). Per-call opts
    // are merged on top of those defaults by Fastify.
    reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      path: COOKIE_PATH,
      maxAge,
    });
  }
}
