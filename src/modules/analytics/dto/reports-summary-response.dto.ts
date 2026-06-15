import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const MonthRevenueSchema = z.object({
  month: z.string(),
  revenue: z.number().nonnegative(),
});

// Net subscriber movement for a month: gross adds vs churn.
const MonthMovementSchema = z.object({
  month: z.string(),
  added: z.number().int(),
  churned: z.number().int(),
});

/**
 * Business reports rollup. Like the dashboard, a read-only cross-module
 * aggregate derived per request — `arpu` is MRR over active subscribers and
 * `churnRate` is the churned share of the base.
 */
export const ReportsSummarySchema = z.object({
  revenueTrend: z.array(MonthRevenueSchema),
  movement: z.array(MonthMovementSchema),
  arpu: z.number().int().nonnegative(),
  churnRate: z.number().min(0).max(1),
});

export type ReportsSummary = z.infer<typeof ReportsSummarySchema>;

export class ReportsSummaryDto extends createZodDto(ReportsSummarySchema) {}
