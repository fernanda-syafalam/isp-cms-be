import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for a voucher. */
export const VoucherResponseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  batchId: z.string(),
  profile: z.string(),
  priceIdr: z.number().int().nonnegative(),
  durationDays: z.number().int().positive(),
  status: z.enum(['unused', 'used', 'expired']),
  usedAt: z.iso.datetime().nullable(),
  usedBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export type VoucherResponse = z.infer<typeof VoucherResponseSchema>;

export class VoucherResponseDto extends createZodDto(VoucherResponseSchema) {}

/** Result of a batch mint. */
export const BatchResultSchema = z.object({
  batchId: z.string(),
  created: z.number().int().nonnegative(),
});

export type BatchResult = z.infer<typeof BatchResultSchema>;

export class BatchResultDto extends createZodDto(BatchResultSchema) {}
