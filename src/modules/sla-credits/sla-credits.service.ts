import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { SlaCredit } from '../../infrastructure/database/schema/sla-credits.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { TicketsRepository } from '../tickets/tickets.repository';
import type { CreateSlaCreditInput } from './dto/create-sla-credit.dto';
import type { SlaCreditListResponse, SlaCreditResponse } from './dto/sla-credit-response.dto';
import { type SlaCreditListFilter, SlaCreditsRepository } from './sla-credits.repository';

@Injectable()
export class SlaCreditsService {
  private readonly logger = new Logger(SlaCreditsService.name);

  constructor(
    private readonly repo: SlaCreditsRepository,
    // Resolve customer / ticket ids from the name / code on the request.
    private readonly customers: CustomersRepository,
    private readonly tickets: TicketsRepository,
  ) {}

  async list(filter: SlaCreditListFilter): Promise<SlaCreditListResponse> {
    const { items, total, summary } = await this.repo.list(filter);
    return { items: items.map(toSlaCreditResponse), total, summary };
  }

  async create(input: CreateSlaCreditInput): Promise<SlaCreditResponse> {
    const customerId = await this.customers.findIdByFullName(input.customerName);
    // Only keep the ticket code if it resolves to a real ticket (matches FE).
    const ticketId = input.ticketCode ? await this.tickets.findIdByCode(input.ticketCode) : null;
    const ticketCode = ticketId ? (input.ticketCode ?? null) : null;

    const credit = await this.repo.create({
      customerId,
      customerName: input.customerName,
      amount: input.amount,
      reason: input.reason,
      ticketId,
      ticketCode,
    });
    this.logger.log({ creditId: credit.id }, 'sla credit created');
    return toSlaCreditResponse(credit);
  }

  /**
   * Apply a pending credit: transition it to `applied` AND reduce the
   * customer's outstanding balance by the credit amount (floored at zero), so
   * the goodwill credit actually lowers what they owe (ADR-0007). This mirrors
   * how plan-change proration adjusts `outstanding` directly; a formal credit
   * invoice-line is a follow-up. Idempotent for an already-applied credit; a
   * void credit cannot be applied. A credit with no resolved customer only
   * transitions state (nothing to deduct).
   */
  async apply(id: string): Promise<SlaCreditResponse> {
    const credit = await this.requireById(id);
    if (credit.status === 'applied') return toSlaCreditResponse(credit);
    if (credit.status === 'void') throw new BadRequestException('credit is void');
    const applied = await this.repo.apply(id);
    if (applied.customerId) {
      const customer = await this.customers.findById(applied.customerId);
      if (customer) {
        const outstanding = Math.max(0, customer.outstanding - applied.amount);
        await this.customers.setBilling(applied.customerId, { outstanding });
      }
    }
    this.logger.log({ creditId: id, customerId: applied.customerId }, 'sla credit applied');
    return toSlaCreditResponse(applied);
  }

  /** Void a pending credit. Idempotent; an applied credit cannot be voided. */
  async void(id: string): Promise<SlaCreditResponse> {
    const credit = await this.requireById(id);
    if (credit.status === 'void') return toSlaCreditResponse(credit);
    if (credit.status === 'applied') {
      throw new BadRequestException('cannot void an applied credit');
    }
    const voided = await this.repo.void(id);
    this.logger.log({ creditId: id }, 'sla credit voided');
    return toSlaCreditResponse(voided);
  }

  private async requireById(id: string): Promise<SlaCredit> {
    const credit = await this.repo.findById(id);
    if (!credit) throw new NotFoundException('sla credit not found');
    return credit;
  }
}

function toSlaCreditResponse(row: SlaCredit): SlaCreditResponse {
  return {
    id: row.id,
    customerId: row.customerId,
    customerName: row.customerName,
    amount: row.amount,
    reason: row.reason,
    ticketId: row.ticketId,
    ticketCode: row.ticketCode,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    appliedAt: row.appliedAt ? row.appliedAt.toISOString() : null,
  };
}
