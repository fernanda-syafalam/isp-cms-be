import { Injectable, Logger } from '@nestjs/common';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { CustomersService } from '../customers/customers.service';
import { InvoicesService } from '../invoices/invoices.service';
import { TicketsService } from '../tickets/tickets.service';
import type { PortalMeResponse } from './dto/portal-me-response.dto';
import type { ReportIssueInput } from './dto/report-issue.dto';

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
  ) {}

  /** The authenticated customer's self-service snapshot. */
  async getMe(user: AuthUser): Promise<PortalMeResponse> {
    const customer = await this.customers.resolveForPortal(user.email);
    const [invoices, payments, tickets] = await Promise.all([
      this.invoices.invoicesByCustomer(customer.id),
      this.invoices.paymentsByCustomer(customer.id),
      this.tickets.listByCustomer(customer.id),
    ]);
    return { customer, invoices, payments, tickets };
  }

  /** Customer reports a problem -> opens a support ticket on their account. */
  async reportIssue(user: AuthUser, input: ReportIssueInput): Promise<void> {
    const customer = await this.customers.resolveForPortal(user.email);
    await this.tickets.create(
      { subject: input.subject, customerName: customer.fullName, priority: REPORTED_PRIORITY },
      user.fullName,
    );
    this.logger.log({ customerId: customer.id }, 'portal issue reported');
  }
}
