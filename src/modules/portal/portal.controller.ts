import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreatePaymentIntentDto } from '../invoices/dto/create-payment-intent.dto';
import { PaymentIntentResponseDto } from '../invoices/dto/payment-intent-response.dto';
import { AddCommentDto } from '../tickets/dto/add-comment.dto';
import { TicketResponseDto } from '../tickets/dto/ticket-response.dto';
import { PortalMeResponseDto } from './dto/portal-me-response.dto';
import { PortalTicketDetailResponseDto } from './dto/portal-ticket-detail-response.dto';
import { ReportIssueDto } from './dto/report-issue.dto';
import { SubmitCsatDto } from './dto/submit-csat.dto';
import { PortalService } from './portal.service';

/**
 * Self-service portal for the authenticated customer. Gated to the
 * customer role now that the customer↔user linkage exists (P1.3): staff
 * act on subscribers through the staff surfaces, never by resolving a
 * portal session — this closes the email-collision impersonation path
 * flagged in the P0 security review (L1).
 */
@Roles('customer')
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

  // Ticket detail + full comment/status timeline, scoped to the caller.
  @Audit('portal.ticket.detail')
  @Get('tickets/:id')
  @ZodSerializerDto(PortalTicketDetailResponseDto)
  ticketDetail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.portal.getTicketDetail(user, id);
  }

  @Audit('portal.ticket.comment')
  @Post('tickets/:id/comments')
  @HttpCode(HttpStatus.CREATED)
  addComment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: AddCommentDto,
  ): Promise<void> {
    return this.portal.addTicketComment(user, id, body);
  }

  // Post-resolution CSAT (P3.C.2) — only allowed on a resolved/breached
  // ticket owned by the caller; the service enforces both.
  @Audit('portal.ticket.csat')
  @Post('tickets/:id/csat')
  @ZodSerializerDto(TicketResponseDto)
  submitCsat(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: SubmitCsatDto) {
    return this.portal.submitTicketCsat(user, id, body);
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
