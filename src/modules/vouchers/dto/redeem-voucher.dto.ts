import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/vouchers/:id/redeem. `customerName` is optional: when
 * present the voucher is sold to that subscriber and its face value pays down
 * their bill; when absent it is an anonymous hotspot/loket redemption.
 */
export const RedeemVoucherSchema = z
  .object({
    customerName: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export type RedeemVoucherInput = z.infer<typeof RedeemVoucherSchema>;

export class RedeemVoucherDto extends createZodDto(RedeemVoucherSchema) {}
