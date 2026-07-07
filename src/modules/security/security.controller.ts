import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ZodSerializerDto } from 'nestjs-zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ConfirmTwoFactorDto } from './dto/confirm-two-factor.dto';
import { DisableTwoFactorDto } from './dto/disable-two-factor.dto';
import { SecurityStateResponseDto } from './dto/security-response.dto';
import { TwoFactorEnrollResponseDto } from './dto/two-factor-enroll-response.dto';
import { SecurityService } from './security.service';

/**
 * Self-service account security for the authenticated user — each caller
 * manages only their OWN 2FA state and sessions (every service method is
 * scoped by the caller's own `userId`/`sessionId`, never another user's).
 *
 * Staff/admin-only in v1 (`@Roles('admin', 'staff')` below correctly
 * EXCLUDES `customer`) — there is no customer-facing security page in the
 * FE yet. Extending self-service 2FA/session management to `customer` is
 * a future product decision, not an oversight; do not widen this without
 * that decision being made explicitly.
 */
@Roles('admin', 'staff')
@Controller({ path: 'security', version: '1' })
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  @Get()
  @ZodSerializerDto(SecurityStateResponseDto)
  get(@CurrentUser() user: AuthUser) {
    return this.security.getState(user.id, user.sessionId);
  }

  /** Step 1/2 — generate + persist a TOTP secret, return the QR payload. */
  @Audit('security.2fa.enroll')
  @Post('2fa/enroll')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(TwoFactorEnrollResponseDto)
  enroll(@CurrentUser() user: AuthUser) {
    return this.security.beginEnroll(user.id, user.email);
  }

  /**
   * Step 2/2 — verify the code from the authenticator app, flip the flag
   * on. F1: throttled tighter than the global default — this is the
   * endpoint an attacker with a stolen-but-unconfirmed secret would
   * brute force; also gated per-user by `TotpLockoutService` inside
   * `SecurityService.confirmEnroll`.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Audit('security.2fa.confirm')
  @Post('2fa/confirm')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(SecurityStateResponseDto)
  confirm(@CurrentUser() user: AuthUser, @Body() body: ConfirmTwoFactorDto) {
    return this.security.confirmEnroll(user.id, body.code, user.sessionId);
  }

  /** F1: same rationale as `confirm` above — this is the other endpoint that checks a TOTP code. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Audit('security.2fa.disable')
  @Post('2fa/disable')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(SecurityStateResponseDto)
  disable(@CurrentUser() user: AuthUser, @Body() body: DisableTwoFactorDto) {
    return this.security.disableTwoFactor(user.id, body.code, user.sessionId);
  }

  @Audit('security.session.revoke')
  @Post('sessions/:id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeSession(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    return this.security.revokeSession(user.id, id);
  }

  @Audit('security.sessions.revoke-others')
  @Post('sessions/revoke-others')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeOtherSessions(@CurrentUser() user: AuthUser): Promise<void> {
    return this.security.revokeOtherSessions(user.id, user.sessionId);
  }
}
