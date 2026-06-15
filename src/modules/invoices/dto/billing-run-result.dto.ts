import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Result of POST /v1/billing/run — the billing period processed and how
 * many invoices were created (zero on a re-run, since invoice generation
 * is idempotent per customer+period).
 */
export const BillingRunResultSchema = z.object({
  period: z.string(), // 'YYYY-MM'
  created: z.number().int().nonnegative(),
});

export type BillingRunResult = z.infer<typeof BillingRunResultSchema>;

export class BillingRunResultDto extends createZodDto(BillingRunResultSchema) {}
