import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for POST /v1/billing/remind — optional explicit invoice ids. */
export const RemindSchema = z
  .object({
    invoiceIds: z.array(z.uuid()).optional(),
  })
  .strict();

export type RemindInput = z.infer<typeof RemindSchema>;
export class RemindDto extends createZodDto(RemindSchema) {}

/** Result of POST /v1/billing/isolir-overdue. */
export const IsolirResultSchema = z.object({
  markedOverdue: z.number().int().nonnegative(),
  isolated: z.number().int().nonnegative(),
  // D7: one bad customer record must never abort the rest of the isolir
  // sweep — surfaced here so an operator/metric sees partial-batch failures
  // instead of a silently-truncated batch.
  failed: z.number().int().nonnegative(),
  failedCustomerIds: z.array(z.uuid()),
});
export type IsolirResult = z.infer<typeof IsolirResultSchema>;
export class IsolirResultDto extends createZodDto(IsolirResultSchema) {}

/** Result of POST /v1/billing/remind. */
export const RemindResultSchema = z.object({
  reminded: z.number().int().nonnegative(),
  channel: z.literal('whatsapp'),
});
export type RemindResult = z.infer<typeof RemindResultSchema>;
export class RemindResultDto extends createZodDto(RemindResultSchema) {}

/** Result of GET /v1/billing/scheduler/preview. */
export const SchedulerPreviewSchema = z.object({
  toBill: z.number().int().nonnegative(),
  toRemindUpcoming: z.number().int().nonnegative(),
  toRemindOverdue: z.number().int().nonnegative(),
  toIsolir: z.number().int().nonnegative(),
});
export type SchedulerPreview = z.infer<typeof SchedulerPreviewSchema>;
export class SchedulerPreviewDto extends createZodDto(SchedulerPreviewSchema) {}

/** Result of POST /v1/billing/scheduler/run. */
export const SchedulerRunResultSchema = z.object({
  period: z.string(),
  created: z.number().int().nonnegative(),
  // D7: aggregated from BillingRunResult['failed'] (invoices.run()) — a
  // failed invoice-creation for one customer never aborts the rest of the
  // nightly cycle.
  billingFailed: z.number().int().nonnegative(),
  remindedUpcoming: z.number().int().nonnegative(),
  remindedOverdue: z.number().int().nonnegative(),
  isolated: z.number().int().nonnegative(),
  // D7: aggregated from IsolirResult['failed'] (isolateActiveDebtors()).
  isolationFailed: z.number().int().nonnegative(),
});
export type SchedulerRunResult = z.infer<typeof SchedulerRunResultSchema>;
export class SchedulerRunResultDto extends createZodDto(SchedulerRunResultSchema) {}
