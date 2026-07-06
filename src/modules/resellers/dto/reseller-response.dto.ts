import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for a reseller. customerCount is derived (by resellerId FK match). */
export const ResellerResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  area: z.string(),
  balance: z.number().int().nonnegative(),
  commissionPct: z.number().nonnegative(),
  customerCount: z.number().int().nonnegative(),
  status: z.enum(['active', 'inactive']),
});

export type ResellerResponse = z.infer<typeof ResellerResponseSchema>;

export class ResellerResponseDto extends createZodDto(ResellerResponseSchema) {}

/** Output shape for a ledger entry (amount is signed). */
export const LedgerEntryResponseSchema = z.object({
  id: z.uuid(),
  resellerId: z.uuid(),
  type: z.enum(['topup', 'commission', 'deduction', 'withdrawal']),
  amount: z.number().int(),
  note: z.string(),
  balanceAfter: z.number().int().nonnegative(),
  at: z.iso.datetime(),
});

export type LedgerEntryResponse = z.infer<typeof LedgerEntryResponseSchema>;

export class LedgerEntryResponseDto extends createZodDto(LedgerEntryResponseSchema) {}
