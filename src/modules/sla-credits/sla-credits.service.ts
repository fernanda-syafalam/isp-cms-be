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
   * Apply a pending credit (deduction from the next invoice happens with the
   * billing-application flow; here it transitions state). Idempotent for an
   * already-applied credit; a void credit cannot be applied.
   */
  async apply(id: string): Promise<SlaCreditResponse> {
    const credit = await this.requireById(id);
    if (credit.status === 'applied') return toSlaCreditResponse(credit);
    if (credit.status === 'void') throw new BadRequestException('credit is void');
    const applied = await this.repo.apply(id);
    this.logger.log({ creditId: id }, 'sla credit applied');
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
