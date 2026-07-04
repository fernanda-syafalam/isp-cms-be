import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { NewVoucher, Voucher } from '../../infrastructure/database/schema/vouchers.schema';
import { CustomersRepository } from '../customers/customers.repository';
import type { GenerateBatchInput } from './dto/generate-batch.dto';
import type { RedeemVoucherInput } from './dto/redeem-voucher.dto';
import type { BatchResult, VoucherListResponse, VoucherResponse } from './dto/voucher-response.dto';
import { type VoucherListFilter, VouchersRepository } from './vouchers.repository';

// 32 unambiguous characters (no O/0/I/1) for printed codes.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

@Injectable()
export class VouchersService {
  private readonly logger = new Logger(VouchersService.name);

  constructor(
    private readonly repo: VouchersRepository,
    // Resolve the buyer + credit their bill when a voucher is sold at a loket.
    private readonly customers: CustomersRepository,
  ) {}

  async list(filter: VoucherListFilter): Promise<VoucherListResponse> {
    const { items, total, summary } = await this.repo.list(filter);
    return { items: items.map(toVoucherResponse), total, summary };
  }

  /** Mint `count` vouchers sharing one batch id; returns the batch summary. */
  async generateBatch(input: GenerateBatchInput): Promise<BatchResult> {
    const batchId = `BATCH-${randomUUID().slice(0, 8).toUpperCase()}`;
    const rows: NewVoucher[] = Array.from({ length: input.count }, () => ({
      code: randomCode(),
      batchId,
      profile: input.profile,
      priceIdr: input.priceIdr,
      durationDays: input.durationDays,
    }));
    const created = await this.repo.createBatch(rows);
    this.logger.log({ batchId, created }, 'voucher batch minted');
    return { batchId, created };
  }

  /**
   * Redeem a voucher. With a `customerName` it is a loket sale to that
   * subscriber: the voucher's face value pays down their outstanding balance
   * (floored at zero) and the redemption is linked to them (ADR-0010/0007).
   * Without one it is an anonymous hotspot redemption — status only.
   */
  async redeem(id: string, input: RedeemVoucherInput = {}): Promise<VoucherResponse> {
    const customerId = input.customerName
      ? await this.customers.findIdByFullName(input.customerName)
      : null;
    const voucher = await this.repo.redeem(id, {
      redeemedCustomerId: customerId,
      usedBy: input.customerName ?? null,
    });
    if (customerId) {
      const customer = await this.customers.findById(customerId);
      if (customer) {
        const outstanding = Math.max(0, customer.outstanding - voucher.priceIdr);
        await this.customers.setBilling(customerId, { outstanding });
      }
    }
    this.logger.log({ voucherId: id, customerId }, 'voucher redeemed');
    return toVoucherResponse(voucher);
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

function toVoucherResponse(row: Voucher): VoucherResponse {
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
    createdAt: row.createdAt.toISOString(),
  };
}
