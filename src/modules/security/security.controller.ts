import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { EnableTwoFactorDto } from './dto/enable-two-factor.dto';
import { SecurityStateResponseDto } from './dto/security-response.dto';
import { SecurityService } from './security.service';

/**
 * Self-service account security for the authenticated user. Not role-gated —
 * every user manages their own 2FA and sessions (JwtAuthGuard already
 * requires authentication).
 */
@Controller({ path: 'security', version: '1' })
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  @Get()
  @ZodSerializerDto(SecurityStateResponseDto)
  get(@CurrentUser() user: AuthUser) {
    return this.security.getState(user.id);
  }

  @Audit('security.2fa.enable')
  @Post('2fa/enable')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(SecurityStateResponseDto)
  enable(@CurrentUser() user: AuthUser, @Body() body: EnableTwoFactorDto) {
    return this.security.enableTwoFactor(user.id, body.code);
  }

  @Audit('security.2fa.disable')
  @Post('2fa/disable')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(SecurityStateResponseDto)
  disable(@CurrentUser() user: AuthUser) {
    return this.security.disableTwoFactor(user.id);
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
