import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { PortalMeResponseDto } from './dto/portal-me-response.dto';
import { ReportIssueDto } from './dto/report-issue.dto';
import { PortalService } from './portal.service';

/**
 * Self-service portal for the authenticated customer. Not role-gated — the
 * snapshot resolves per-user (a real backend scopes strictly to the token);
 * JwtAuthGuard already requires authentication.
 */
@Controller({ path: 'portal', version: '1' })
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Get('me')
  @ZodSerializerDto(PortalMeResponseDto)
  me(@CurrentUser() user: AuthUser) {
    return this.portal.getMe(user);
  }

  @Audit('portal.ticket.report')
  @Post('tickets')
  @HttpCode(HttpStatus.NO_CONTENT)
  report(@CurrentUser() user: AuthUser, @Body() body: ReportIssueDto): Promise<void> {
    return this.portal.reportIssue(user, body);
  }
}
