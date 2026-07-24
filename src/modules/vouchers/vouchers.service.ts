import { randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { NewVoucher } from '../../infrastructure/database/schema/vouchers.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { ResellersRepository } from '../resellers/resellers.repository';
import type { GenerateBatchInput } from './dto/generate-batch.dto';
import type { RedeemVoucherInput } from './dto/redeem-voucher.dto';
import type { BatchResult, VoucherListResponse, VoucherResponse } from './dto/voucher-response.dto';
import { type VoucherListFilter, type VoucherRow, VouchersRepository } from './vouchers.repository';

// 32 unambiguous characters (no O/0/I/1) for printed codes.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

@Injectable()
export class VouchersService {
  private readonly logger = new Logger(VouchersService.name);

  constructor(
    private readonly repo: VouchersRepository,
    // Resolve the buyer + credit their bill when a voucher is sold at a loket.
    private readonly customers: CustomersRepository,
    // Validates an incoming resellerId FK before it reaches the DB, used only
    // by `generateBatch` (mirrors CustomersService.requireResellerIfProvided,
    // P3.D.2). NOT used by `redeem` — ADR-0018 decision #2 (reseller OFF
    // day-1) / ABUSE-2 removed the redeem-time resellerId entirely.
    private readonly resellers: ResellersRepository,
  ) {}

  async list(filter: VoucherListFilter): Promise<VoucherListResponse> {
    const { items, total, summary } = await this.repo.list(filter);
    return { items: items.map(toVoucherResponse), total, summary };
  }

  /**
   * Mint `count` vouchers sharing one batch id; returns the batch summary.
   * An optional `resellerId` attributes the whole batch to a mitra (P3.D.3)
   * — validated here (400) rather than left to fail as a DB FK violation.
   */
  async generateBatch(input: GenerateBatchInput): Promise<BatchResult> {
    await this.requireResellerIfProvided(input.resellerId);

    const batchId = `BATCH-${randomUUID().slice(0, 8).toUpperCase()}`;
    const rows: NewVoucher[] = Array.from({ length: input.count }, () => ({
      code: randomCode(),
      batchId,
      profile: input.profile,
      priceIdr: input.priceIdr,
      durationDays: input.durationDays,
      resellerId: input.resellerId ?? null,
    }));
    const created = await this.repo.createBatch(rows);
    this.logger.log({ batchId, created, resellerId: input.resellerId }, 'voucher batch minted');
    return { batchId, created };
  }

  /**
   * Redeem a voucher — the whole loket settlement (P3.D.3, ADR-0010): with a
   * `customerName` it is a sale to that subscriber (their outstanding
   * balance is credited by the voucher's face value, floored at zero, and
   * the redemption is linked to them). Without one it is an anonymous
   * hotspot redemption — status only, no billing effect. Both writes happen
   * atomically in `VouchersRepository.settle` — this service only resolves
   * the human-supplied `customerName` into a customer id before delegating.
   *
   * ADR-0018 decision #2 (reseller OFF day-1) / ABUSE-2: redeem never posts a
   * reseller commission and never takes a `resellerId` from the caller — see
   * `RedeemVoucherSchema` and `VouchersRepository.settle`.
   */
  async redeem(id: string, input: RedeemVoucherInput = {}): Promise<VoucherResponse> {
    const customerId = input.customerName
      ? await this.customers.findIdByFullName(input.customerName)
      : null;

    await this.repo.settle(id, {
      redeemedCustomerId: customerId,
      usedBy: input.customerName ?? null,
    });

    // Re-read through the joined view so the response carries resellerName
    // (settle() returns the plain table row, without the join).
    const voucher = await this.repo.findById(id);
    if (!voucher) {
      throw new NotFoundException('voucher not found');
    }

    this.logger.log({ voucherId: id, customerId }, 'voucher redeemed');
    return toVoucherResponse(voucher);
  }

  /**
   * Guard for the optional resellerId FK (P3.D.3, mirrors
   * CustomersService.requireResellerIfProvided, P3.D.2): when a caller
   * supplies one, it must reference a real reseller — otherwise this fails
   * explicit (400) here instead of at the DB as an FK-violation 500.
   */
  private async requireResellerIfProvided(resellerId?: string | null): Promise<void> {
    if (!resellerId) return;
    const reseller = await this.resellers.findById(resellerId);
    if (!reseller) {
      throw new BadRequestException('reseller not found');
    }
  }
}

function randomCode(): string {
  const bytes = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i += 1) {
    // biome-ignore lint/style/noNonNullAssertion: i < 8 = bytes length
    s += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return `ASH-${s.slice(0, 4)}-${s.slice(4, 8)}`;
}

function toVoucherResponse(row: VoucherRow): VoucherResponse {
  return {
    id: row.id,
    code: row.code,
    batchId: row.batchId,
    profile: row.profile,
    priceIdr: row.priceIdr,
    durationDays: row.durationDays,
    status: row.status,
    usedAt: row.usedAt ? row.usedAt.toISOString() : null,
    usedBy: row.usedBy,
    resellerId: row.resellerId,
    resellerName: row.resellerName,
    createdAt: row.createdAt.toISOString(),
  };
}
