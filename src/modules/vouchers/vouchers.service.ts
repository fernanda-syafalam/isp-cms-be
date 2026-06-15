import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { NewVoucher, Voucher } from '../../infrastructure/database/schema/vouchers.schema';
import type { GenerateBatchInput } from './dto/generate-batch.dto';
import type { BatchResult, VoucherResponse } from './dto/voucher-response.dto';
import { type VoucherListFilter, VouchersRepository } from './vouchers.repository';

// 32 unambiguous characters (no O/0/I/1) for printed codes.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

@Injectable()
export class VouchersService {
  private readonly logger = new Logger(VouchersService.name);

  constructor(private readonly repo: VouchersRepository) {}

  async list(filter: VoucherListFilter): Promise<{ items: VoucherResponse[]; total: number }> {
    const { items, total } = await this.repo.list(filter);
    return { items: items.map(toVoucherResponse), total };
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

  async redeem(id: string): Promise<VoucherResponse> {
    const voucher = await this.repo.redeem(id);
    this.logger.log({ voucherId: id }, 'voucher redeemed');
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
