import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// A single point on a monthly revenue series.
const MonthRevenueSchema = z.object({
  month: z.string(),
  revenue: z.number().nonnegative(),
});

// A labelled count slice (status breakdown, lifecycle mix).
const StatusCountSchema = z.object({
  label: z.string(),
  count: z.number().int().nonnegative(),
});

/**
 * Operations dashboard rollup. A read-only cross-module aggregate — none of
 * these numbers is stored; they are derived per request from customers,
 * invoices, tickets, devices, leads, monitoring and SLA-credit reads.
 *
 * The three short trend series (`subscriberTrend`/`isolatedTrend`/`arTrend`)
 * power KPI sparklines. There is no historical snapshot table yet, so they
 * flat-line at the current value rather than fabricate movement.
 */
export const DashboardSummarySchema = z.object({
  activeSubscribers: z.number().int().nonnegative(),
  newThisMonth: z.number().int(),
  isolatedSubscribers: z.number().int().nonnegative(),
  mrr: z.number().int().nonnegative(),
  arOutstanding: z.number().int().nonnegative(), // total receivables
  overdueAmount: z.number().int().nonnegative(),
  overdueCount: z.number().int().nonnegative(),
  openTickets: z.number().int().nonnegative(),
  slaCompliance: z.number().min(0).max(1),
  devicesOnline: z.number().int().nonnegative(),
  devicesTotal: z.number().int().nonnegative(),
  revenueTrend: z.array(MonthRevenueSchema),
  ticketsByStatus: z.array(StatusCountSchema),
  subscriberTrend: z.array(z.number()),
  isolatedTrend: z.array(z.number()),
  arTrend: z.array(z.number()),
  // Cross-module rollup surfaced as the dashboard "command center".
  commandCenter: z.object({
    pipelineValue: z.number().int().nonnegative(),
    activeLeads: z.number().int().nonnegative(),
    churnRate: z.number().min(0).max(1),
    slaCreditsPending: z.number().int().nonnegative(),
    devicesAlert: z.number().int().nonnegative(),
    odpFull: z.number().int().nonnegative(),
  }),
  // Subscriber distribution by lifecycle status.
  customerMix: z.array(StatusCountSchema),
  // Receivable aging buckets.
  arAging: z.array(
    z.object({
      bucket: z.string(),
      amount: z.number().int().nonnegative(),
    }),
  ),
});

export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;

export class DashboardSummaryDto extends createZodDto(DashboardSummarySchema) {}
