import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreatePaymentIntentDto } from '../invoices/dto/create-payment-intent.dto';
import { PaymentIntentResponseDto } from '../invoices/dto/payment-intent-response.dto';
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

  // Customer-scoped gateway charge (P0.4): staff use /v1/payments/intent to
  // act on anyone; a customer pays only their own invoices here.
  @Audit('portal.pay_intent.create')
  @Post('pay-intent')
  @ZodSerializerDto(PaymentIntentResponseDto)
  createPayIntent(@CurrentUser() user: AuthUser, @Body() body: CreatePaymentIntentDto) {
    return this.portal.createPayIntent(user, body);
  }

  @Audit('portal.pay_intent.confirm')
  @Post('pay-intent/:id/confirm')
  @ZodSerializerDto(PaymentIntentResponseDto)
  confirmPayIntent(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.portal.confirmPayIntent(user, id);
  }
}
