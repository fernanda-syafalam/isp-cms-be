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
  // D7: invoice generation now wraps each customer in its own try/catch so
  // one bad billable record can't abort the rest of the run — surfaced here
  // so an operator/metric can see partial-batch failures.
  failed: z.number().int().nonnegative(),
  failedCustomerIds: z.array(z.uuid()),
});

export type BillingRunResult = z.infer<typeof BillingRunResultSchema>;

export class BillingRunResultDto extends createZodDto(BillingRunResultSchema) {}
