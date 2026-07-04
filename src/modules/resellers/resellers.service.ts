import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import type {
  Reseller,
  ResellerLedgerEntry,
} from '../../infrastructure/database/schema/resellers.schema';
import { CustomersRepository } from '../customers/customers.repository';
import type { AddLedgerEntryInput } from './dto/add-ledger-entry.dto';
import type { LedgerEntryResponse, ResellerResponse } from './dto/reseller-response.dto';
import type { UpdateResellerInput } from './dto/update-reseller.dto';
import {
  type LedgerListFilter,
  type ResellerListFilter,
  ResellersRepository,
} from './resellers.repository';

@Injectable()
export class ResellersService {
  private readonly logger = new Logger(ResellersService.name);

  constructor(
    private readonly repo: ResellersRepository,
    // customerCount is derived from customers linked by reseller name.
    private readonly customers: CustomersRepository,
  ) {}

  async list(filter: ResellerListFilter): Promise<{ items: ResellerResponse[]; total: number }> {
    const { items, total } = await this.repo.list(filter);
    const counts = await this.customers.countsByResellerName();
    const byName = new Map(counts.map((c) => [c.resellerName, c.count]));
    return {
      items: items.map((r) => toResellerResponse(r, byName.get(r.name) ?? 0)),
      total,
    };
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
    const reseller = await this.repo.addLedgerEntry(id, {
      type: input.type,
      amount: input.amount,
      note: input.note ?? '',
    });
    this.logger.log({ resellerId: id, type: input.type }, 'reseller ledger entry');
    return this.withCount(reseller);
  }

  private async withCount(reseller: Reseller): Promise<ResellerResponse> {
    const customerCount = await this.customers.countByResellerName(reseller.name);
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

/**
 * A mitra principal may only read their own reseller (P1.5, ADR-0010).
 * Misses 404 (not 403) so other resellers' existence is not probeable.
 * Staff/admin (and internal calls with no user) pass through.
 */
function assertResellerAccess(id: string, user?: AuthUser): void {
  if (!user || user.role !== 'mitra') return;
  if (user.resellerId !== id) throw new NotFoundException('reseller not found');
}
