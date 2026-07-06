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
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AnyAuthenticatedRole } from '../../common/decorators/any-authenticated-role.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { BootstrapDto } from './dto/bootstrap.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';

/** @fastify/cookie augments FastifyRequest with a `cookies` record after plugin registration. */
type CookieRequest = FastifyRequest & { cookies: Record<string, string | undefined> };

const REFRESH_COOKIE = 'refresh_token';
const COOKIE_PATH = '/v1/auth';

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ accessToken: string; user: AuthUser }> {
    const result = await this.auth.login(body.email, body.password);
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
    const result = await this.auth.refresh(rawToken);
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
      await this.auth.logout(rawToken);
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
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ accessToken: string; user: AuthUser }> {
    const result = await this.auth.bootstrapAdmin(body);
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
