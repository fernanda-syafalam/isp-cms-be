import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import type {
  Reseller,
  ResellerLedgerEntry,
  ResellerPayout,
} from '../../infrastructure/database/schema/resellers.schema';
import { CustomersRepository } from '../customers/customers.repository';
import type { AddLedgerEntryInput } from './dto/add-ledger-entry.dto';
import type { CreatePayoutInput } from './dto/create-payout.dto';
import type { CreateResellerInput } from './dto/create-reseller.dto';
import type { PayoutResponse } from './dto/payout-response.dto';
import type {
  LedgerEntryResponse,
  ResellerListResponse,
  ResellerResponse,
} from './dto/reseller-response.dto';
import type { UpdateResellerInput } from './dto/update-reseller.dto';
import {
  type LedgerListFilter,
  type PayoutListFilter,
  type ResellerListFilter,
  ResellersRepository,
} from './resellers.repository';

@Injectable()
export class ResellersService {
  private readonly logger = new Logger(ResellersService.name);

  constructor(
    private readonly repo: ResellersRepository,
    // customerCount is derived from customers linked by resellerId (FK) —
    // never a name match, which would drift the moment a reseller renames.
    private readonly customers: CustomersRepository,
  ) {}

  async list(filter: ResellerListFilter): Promise<ResellerListResponse> {
    const { items, total, summary } = await this.repo.list(filter);
    const counts = await this.customers.countsByResellerId();
    const byId = new Map(counts.map((c) => [c.resellerId, c.count]));
    return {
      items: items.map((r) => toResellerResponse(r, byId.get(r.id) ?? 0)),
      total,
      summary,
    };
  }

  async create(input: CreateResellerInput): Promise<ResellerResponse> {
    const reseller = await this.repo.create({
      name: input.name,
      area: input.area,
      commissionPct: input.commissionPct,
      status: input.status ?? 'active',
    });
    this.logger.log({ resellerId: reseller.id }, 'reseller created');
    // A brand-new reseller has no linked customers yet — skip the count query.
    return toResellerResponse(reseller, 0);
  }

  async findById(id: string, user?: AuthUser): Promise<ResellerResponse> {
    assertResellerAccess(id, user);
    const reseller = await this.requireById(id);
    return this.withCount(reseller);
  }

  async update(id: string, input: UpdateResellerInput): Promise<ResellerResponse> {
    const reseller = await this.repo.update(id, input);
    this.logger.log({ resellerId: id }, 'reseller updated');
    return this.withCount(reseller);
  }

  async listLedger(
    id: string,
    filter: LedgerListFilter,
    user?: AuthUser,
  ): Promise<{ items: LedgerEntryResponse[]; total: number }> {
    assertResellerAccess(id, user);
    await this.requireById(id);
    const { items, total } = await this.repo.listLedger(id, filter);
    return { items: items.map(toLedgerEntryResponse), total };
  }

  async addLedgerEntry(id: string, input: AddLedgerEntryInput): Promise<ResellerResponse> {
    // Withdrawals may only be posted by disbursePayout (P3.D.4) — the
    // bare ledger endpoint is for topup/commission/deduction only, so a
    // withdrawal can never bypass the approval workflow.
    if (input.type === 'withdrawal') {
      throw new UnprocessableEntityException('Gunakan alur payout');
    }
    const reseller = await this.repo.addLedgerEntry(id, {
      type: input.type,
      amount: input.amount,
      note: input.note ?? '',
    });
    this.logger.log({ resellerId: id, type: input.type }, 'reseller ledger entry');
    return this.withCount(reseller);
  }

  // --- Payout lifecycle (P3.D.4) ---------------------------------------

  async listPayouts(
    id: string,
    filter: PayoutListFilter,
    user?: AuthUser,
  ): Promise<{ items: PayoutResponse[]; total: number }> {
    assertResellerAccess(id, user);
    await this.requireById(id);
    const { items, total } = await this.repo.listPayouts(id, filter);
    return { items: items.map(toPayoutResponse), total };
  }

  async requestPayout(
    id: string,
    input: CreatePayoutInput,
    actorId: string | null,
  ): Promise<PayoutResponse> {
    const payout = await this.repo.createPayout(id, {
      amount: input.amount,
      note: input.note ?? '',
      requestedBy: actorId,
    });
    this.logger.log({ resellerId: id, payoutId: payout.id }, 'reseller payout requested');
    return toPayoutResponse(payout);
  }

  async approvePayout(
    id: string,
    payoutId: string,
    actorId: string | null,
  ): Promise<PayoutResponse> {
    await this.requirePayoutForReseller(id, payoutId);
    const payout = await this.repo.approvePayout(payoutId, actorId);
    this.logger.log({ resellerId: id, payoutId }, 'reseller payout approved');
    return toPayoutResponse(payout);
  }

  async rejectPayout(
    id: string,
    payoutId: string,
    actorId: string | null,
  ): Promise<PayoutResponse> {
    await this.requirePayoutForReseller(id, payoutId);
    const payout = await this.repo.rejectPayout(payoutId, actorId);
    this.logger.log({ resellerId: id, payoutId }, 'reseller payout rejected');
    return toPayoutResponse(payout);
  }

  async disbursePayout(
    id: string,
    payoutId: string,
    actorId: string | null,
  ): Promise<PayoutResponse> {
    await this.requirePayoutForReseller(id, payoutId);
    const payout = await this.repo.disbursePayout(payoutId);
    // The disburser is also captured by @Audit('reseller.payout.disburse');
    // logging it here keeps the actor in the app log too (security-review M1).
    this.logger.log({ resellerId: id, payoutId, actorId }, 'reseller payout disbursed');
    return toPayoutResponse(payout);
  }

  /** 404s (not just on the reseller, but on the payout too) if the payout id given does not belong to this reseller — prevents cross-reseller payout id guessing. */
  private async requirePayoutForReseller(resellerId: string, payoutId: string): Promise<void> {
    await this.requireById(resellerId);
    const payout = await this.repo.findPayoutById(payoutId);
    if (!payout || payout.resellerId !== resellerId) {
      throw new NotFoundException('payout not found');
    }
  }

  private async withCount(reseller: Reseller): Promise<ResellerResponse> {
    const customerCount = await this.customers.countByResellerId(reseller.id);
    return toResellerResponse(reseller, customerCount);
  }

  private async requireById(id: string): Promise<Reseller> {
    const reseller = await this.repo.findById(id);
    if (!reseller) throw new NotFoundException('reseller not found');
    return reseller;
  }
}

function toResellerResponse(row: Reseller, customerCount: number): ResellerResponse {
  return {
    id: row.id,
    name: row.name,
    area: row.area,
    balance: row.balance,
    commissionPct: row.commissionPct,
    customerCount,
    status: row.status,
  };
}

function toLedgerEntryResponse(row: ResellerLedgerEntry): LedgerEntryResponse {
  return {
    id: row.id,
    resellerId: row.resellerId,
    type: row.type,
    amount: row.amount,
    note: row.note,
    balanceAfter: row.balanceAfter,
    at: row.at.toISOString(),
  };
}

function toPayoutResponse(row: ResellerPayout): PayoutResponse {
  return {
    id: row.id,
    resellerId: row.resellerId,
    amount: row.amount,
    status: row.status,
    note: row.note,
    requestedBy: row.requestedBy,
    decidedBy: row.decidedBy,
    ledgerEntryId: row.ledgerEntryId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
  };
}

/**
 * A mitra principal may only read their own reseller (P1.5, ADR-0010).
 * Misses 404 (not 403) so other resellers' existence is not probeable.
 * Staff/admin (and internal calls with no user) pass through.
 */
function assertResellerAccess(id: string, user?: AuthUser): void {
  if (!user || user.role !== 'mitra') return;
  if (user.resellerId !== id) throw new NotFoundException('reseller not found');
}
