import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/vouchers/:id/redeem. `customerName` is optional: when
 * present the voucher is sold to that subscriber and its face value pays down
 * their bill; when absent it is an anonymous hotspot/loket redemption.
 *
 * ADR-0018 decision #2 (reseller OFF day-1) + ABUSE-2 fix: this schema
 * deliberately has NO `resellerId` field. It previously let the redeeming
 * caller pick which mitra got paid a commission (self-dealing) — a redeemer
 * could route commission to any reseller id, including their own. Commission
 * attribution, if ever re-enabled, must derive only from the voucher's own
 * minted-batch `resellerId` (see `GenerateBatchSchema`), never from the
 * redeem request body. `.strict()` below makes a stray `resellerId` in the
 * body a 400 (ZodValidationPipe), not a silently-dropped field.
 */
export const RedeemVoucherSchema = z
  .object({
    customerName: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export type RedeemVoucherInput = z.infer<typeof RedeemVoucherSchema>;

export class RedeemVoucherDto extends createZodDto(RedeemVoucherSchema) {}
