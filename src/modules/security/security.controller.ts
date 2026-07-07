import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
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
 * Self-service account security for the authenticated user. Not role-gated —
 * every user manages their own 2FA and sessions (JwtAuthGuard already
 * requires authentication).
 */
@Roles('admin', 'staff')
@Controller({ path: 'security', version: '1' })
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  @Get()
  @ZodSerializerDto(SecurityStateResponseDto)
  get(@CurrentUser() user: AuthUser) {
    return this.security.getState(user.id);
  }

  /** Step 1/2 — generate + persist a TOTP secret, return the QR payload. */
  @Audit('security.2fa.enroll')
  @Post('2fa/enroll')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(TwoFactorEnrollResponseDto)
  enroll(@CurrentUser() user: AuthUser) {
    return this.security.beginEnroll(user.id, user.email);
  }

  /** Step 2/2 — verify the code from the authenticator app, flip the flag on. */
  @Audit('security.2fa.confirm')
  @Post('2fa/confirm')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(SecurityStateResponseDto)
  confirm(@CurrentUser() user: AuthUser, @Body() body: ConfirmTwoFactorDto) {
    return this.security.confirmEnroll(user.id, body.code);
  }

  @Audit('security.2fa.disable')
  @Post('2fa/disable')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(SecurityStateResponseDto)
  disable(@CurrentUser() user: AuthUser, @Body() body: DisableTwoFactorDto) {
    return this.security.disableTwoFactor(user.id, body.code);
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
    return this.security.revokeOtherSessions(user.id);
  }
}
