import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { AcsService } from '../acs/acs.service';
import type { SetWifiInput } from '../acs/dto/set-wifi.dto';
import type { SetWifiResult, WifiResponse } from '../acs/dto/wifi-response.dto';
import { AnnouncementsService } from '../announcements/announcements.service';
import type { AnnouncementResponse } from '../announcements/dto/announcement-response.dto';
import { CustomersService } from '../customers/customers.service';
import type { CreatePaymentIntentInput } from '../invoices/dto/create-payment-intent.dto';
import type { PaymentIntentResponse } from '../invoices/dto/payment-intent-response.dto';
import { InvoicesService } from '../invoices/invoices.service';
import { PaymentIntentsService } from '../invoices/payment-intents.service';
import type { AddCommentInput } from '../tickets/dto/add-comment.dto';
import type { TicketResponse } from '../tickets/dto/ticket-response.dto';
import { TicketsService } from '../tickets/tickets.service';
import type { UsageResponse } from '../usage/dto/usage-response.dto';
import { UsageService } from '../usage/usage.service';
import type { PortalMeResponse } from './dto/portal-me-response.dto';
import type { PortalTicketDetailResponse } from './dto/portal-ticket-detail-response.dto';
import type { ReportIssueInput } from './dto/report-issue.dto';
import type { SubmitCsatInput } from './dto/submit-csat.dto';

// A customer-reported issue opens at normal priority; staff triage adjusts it.
const REPORTED_PRIORITY = 'medium' as const;

/**
 * The customer self-service portal. A thin aggregator: it resolves the
 * subscriber behind the session, then reads their own data from the owning
 * modules' services (no direct table access).
 */
@Injectable()
export class PortalService {
  private readonly logger = new Logger(PortalService.name);

  constructor(
    private readonly customers: CustomersService,
    private readonly invoices: InvoicesService,
    private readonly tickets: TicketsService,
    private readonly intents: PaymentIntentsService,
    private readonly usage: UsageService,
    private readonly acs: AcsService,
    private readonly announcements: AnnouncementsService,
  ) {}

  /** The authenticated customer's self-service snapshot. */
  async getMe(user: AuthUser): Promise<PortalMeResponse> {
    const customer = await this.customers.resolveForPortal(user);
    const [invoices, payments, tickets, pendingIntents] = await Promise.all([
      this.invoices.invoicesByCustomer(customer.id),
      this.invoices.paymentsByCustomer(customer.id),
      this.tickets.listByCustomer(customer.id),
      this.intents.pendingForCustomer(customer.id),
    ]);
    return { customer, invoices, payments, tickets, pendingIntents };
  }

  /**
   * Open a gateway charge for one of the customer's own invoices (P0.4).
   * The subscriber is resolved from the session; ownership of the target
   * invoice is enforced inside the intents service.
   */
  async createPayIntent(
    user: AuthUser,
    input: CreatePaymentIntentInput,
  ): Promise<PaymentIntentResponse> {
    const customer = await this.customers.resolveForPortal(user);
    return this.intents.createForCustomer(customer.id, input);
  }

  /**
   * Poll the status of the customer's own gateway charge (SEC-H1 interim
   * fix). This is deliberately read-only: settlement now only happens
   * through the staff/admin route (or, P4 future, a signed gateway
   * webhook) — a customer can create an intent and watch it, never flip
   * it to paid themselves.
   */
  async getPayIntent(user: AuthUser, intentId: string): Promise<PaymentIntentResponse> {
    const customer = await this.customers.resolveForPortal(user);
    return this.intents.findForCustomer(customer.id, intentId);
  }

  /** Customer reports a problem -> opens a support ticket on their account. */
  async reportIssue(user: AuthUser, input: ReportIssueInput): Promise<void> {
    const customer = await this.customers.resolveForPortal(user);
    await this.tickets.create(
      {
        subject: input.subject,
        customerName: customer.fullName,
        priority: REPORTED_PRIORITY,
        category: input.category,
        photoUrl: input.photoUrl,
      },
      user.fullName,
    );
    this.logger.log({ customerId: customer.id }, 'portal issue reported');
  }

  /**
   * A single ticket + its timeline, scoped to the requesting customer
   * (P3.C.2). Ownership is always re-checked here, from the resolved
   * portal customer — a ticket id in the URL is never trusted alone.
   */
  async getTicketDetail(user: AuthUser, ticketId: string): Promise<PortalTicketDetailResponse> {
    const ticket = await this.ownTicketOrThrow(user, ticketId);
    const { items } = await this.tickets.listEvents(ticket.id);
    return { ...ticket, events: items };
  }

  /** Add a comment to the customer's own ticket. */
  async addTicketComment(user: AuthUser, ticketId: string, input: AddCommentInput): Promise<void> {
    const ticket = await this.ownTicketOrThrow(user, ticketId);
    await this.tickets.addComment(ticket.id, input, user.fullName);
  }

  /** Rate the outcome of the customer's own resolved/breached ticket. */
  async submitTicketCsat(
    user: AuthUser,
    ticketId: string,
    input: SubmitCsatInput,
  ): Promise<TicketResponse> {
    const ticket = await this.ownTicketOrThrow(user, ticketId);
    return this.tickets.submitCsat(
      ticket.id,
      { rating: input.rating, comment: input.comment ?? null },
      user.fullName,
    );
  }

  // Resolve the session's customer, then load the ticket only if it
  // belongs to that customer — never resolve a portal ticket by id alone.
  private async ownTicketOrThrow(user: AuthUser, ticketId: string): Promise<TicketResponse> {
    const customer = await this.customers.resolveForPortal(user);
    const ticket = await this.tickets.findByIdForCustomer(ticketId, customer.id);
    if (!ticket) throw new NotFoundException('ticket not found');
    return ticket;
  }

  // --- Self-care: usage / WiFi / announcements (P3.C.4) ---------------------
  //
  // Every method below resolves the caller's own customer from the session
  // first, then scopes the downstream call to that customer's id/name —
  // never a client-supplied id (same IDOR posture as the ticket methods
  // above).

  /** The authenticated customer's own data-usage/quota snapshot. */
  async getUsage(user: AuthUser): Promise<UsageResponse> {
    const customer = await this.customers.resolveForPortal(user);
    return this.usage.forCustomer(customer.id);
  }

  /** The authenticated customer's current WiFi SSID/serial/model (ACS seam). */
  async getWifi(user: AuthUser): Promise<WifiResponse> {
    const customer = await this.customers.resolveForPortal(user);
    return this.acs.wifiForCustomer(customer.fullName);
  }

  /** Change the authenticated customer's own WiFi SSID/password. */
  async updateWifi(user: AuthUser, input: SetWifiInput): Promise<SetWifiResult> {
    const customer = await this.customers.resolveForPortal(user);
    return this.acs.setWifiForCustomer(customer.fullName, input.ssid, input.password);
  }

  /** Active announcements/outage notices — the same feed for every customer. */
  async getAnnouncements(): Promise<AnnouncementResponse[]> {
    return this.announcements.listActive();
  }
}
