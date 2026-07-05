import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Per-method totals for a single day's payments (the loket closing report). */
export const PaymentReconciliationLineSchema = z.object({
  method: z.enum(['qris', 'va', 'ewallet', 'transfer', 'cash']),
  count: z.number().int().nonnegative(),
  totalAmount: z.number().int().nonnegative(),
});

export type PaymentReconciliationLine = z.infer<typeof PaymentReconciliationLineSchema>;

/**
 * Output shape for GET /v1/payments/reconciliation — a day's cash-drawer /
 * gateway closing report (P3.A.4). `byMethod` never includes a zero-count
 * method. `cash` is the tendered/change roll-up over `method: 'cash'` rows
 * only (both zero when no cash was taken that day).
 */
export const PaymentReconciliationSchema = z.object({
  date: z.string(), // 'YYYY-MM-DD'
  byMethod: z.array(PaymentReconciliationLineSchema),
  totalCount: z.number().int().nonnegative(),
  totalAmount: z.number().int().nonnegative(),
  cash: z.object({
    totalTendered: z.number().int().nonnegative(),
    totalChange: z.number().int().nonnegative(),
  }),
});

export type PaymentReconciliation = z.infer<typeof PaymentReconciliationSchema>;

export class PaymentReconciliationDto extends createZodDto(PaymentReconciliationSchema) {}
