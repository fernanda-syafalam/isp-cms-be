import { Injectable } from '@nestjs/common';
import { daysBetweenDates, wibDateString } from '../../common/utils/wib-date';
import type { Invoice } from '../../infrastructure/database/schema/invoices.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { DevicesRepository } from '../devices/devices.repository';
import { InvoicesRepository } from '../invoices/invoices.repository';
import { LeadsRepository } from '../leads/leads.repository';
import { MonitoringRepository } from '../monitoring/monitoring.repository';
import { SlaCreditsRepository } from '../sla-credits/sla-credits.repository';
import { TicketsRepository } from '../tickets/tickets.repository';
import type { DashboardSummary } from './dto/dashboard-summary-response.dto';
import type { ReportsSummary } from './dto/reports-summary-response.dto';

// Trend charts and sparklines cover a rolling six-month window.
const MONTH_WINDOW = 6;
const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * Read-only cross-module rollup for the operations dashboard and business
 * reports. Owns no table: every number is derived per request from the
 * customers / invoices / tickets / devices / leads / monitoring / SLA-credit
 * repositories (each the sole owner of its table, Pilar 3).
 *
 * Two values are honest placeholders until their owning module exists:
 *   - `commandCenter.odpFull` is 0 (ODP capacity lives in the topology
 *     module, not yet built).
 *   - the KPI sparkline series flat-line at the current value (there is no
 *     historical snapshot table to reconstruct movement from). `revenueTrend`
 *     and `movement`, by contrast, are real — derived from payments and
 *     subscriber timestamps.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly customers: CustomersRepository,
    private readonly invoices: InvoicesRepository,
    private readonly tickets: TicketsRepository,
    private readonly devices: DevicesRepository,
    private readonly leads: LeadsRepository,
    private readonly monitoring: MonitoringRepository,
    private readonly slaCredits: SlaCreditsRepository,
  ) {}

  async getDashboard(): Promise<DashboardSummary> {
    const now = new Date();
    const window = buildMonthWindow(now);

    const [
      statusCounts,
      newThisMonth,
      atRisk,
      activeBillable,
      unpaid,
      revenueRows,
      ticketCounts,
      deviceCounts,
      pipeline,
      slaCreditsPending,
      devicesAlert,
    ] = await Promise.all([
      this.customers.countByStatus(),
      this.customers.countCreatedSince(startOfMonthUtc(now)),
      this.customers.countAtRisk(),
      this.customers.findActiveBillable(),
      this.invoices.listUnpaid(),
      this.invoices.revenueByMonth(window.since),
      this.tickets.countByStatus(),
      this.devices.countByStatus(),
      this.leads.activePipeline(),
      this.slaCredits.countPending(),
      this.monitoring.countUnacknowledged(),
    ]);

    const totalCustomers = sumValues(statusCounts);
    const mrr = activeBillable.reduce((sum, c) => sum + c.planPriceMonthly, 0);

    const arOutstanding = unpaid.reduce((sum, inv) => sum + invoiceBalanceDue(inv), 0);
    const overdue = unpaid.filter((inv) => inv.status === 'overdue');
    const overdueAmount = overdue.reduce((sum, inv) => sum + invoiceBalanceDue(inv), 0);

    return {
      activeSubscribers: statusCounts.aktif,
      newThisMonth,
      isolatedSubscribers: statusCounts.isolir,
      mrr,
      arOutstanding,
      overdueAmount,
      overdueCount: overdue.length,
      openTickets: ticketCounts.open,
      // Of the tickets that reached a terminal state, the share that met SLA.
      slaCompliance: ratio(ticketCounts.resolved, ticketCounts.resolved + ticketCounts.breached, 1),
      devicesOnline: deviceCounts.online,
      devicesTotal: deviceCounts.online + deviceCounts.degraded + deviceCounts.offline,
      revenueTrend: fillRevenue(window.months, revenueRows),
      ticketsByStatus: [
        { label: 'Terbuka', count: ticketCounts.open },
        { label: 'Diproses', count: ticketCounts.in_progress },
        { label: 'Selesai', count: ticketCounts.resolved },
      ],
      // No historical snapshots yet — sparklines flat-line at the current value.
      subscriberTrend: flat(statusCounts.aktif),
      isolatedTrend: flat(statusCounts.isolir),
      arTrend: flat(arOutstanding),
      commandCenter: {
        pipelineValue: pipeline.value,
        activeLeads: pipeline.count,
        churnRate: ratio(atRisk, totalCustomers, 0),
        slaCreditsPending,
        devicesAlert,
        // ODP capacity is owned by the topology module (not built yet).
        odpFull: 0,
      },
      customerMix: [
        { label: 'Prospek', count: statusCounts.prospek },
        { label: 'Instalasi', count: statusCounts.instalasi },
        { label: 'Aktif', count: statusCounts.aktif },
        { label: 'Isolir', count: statusCounts.isolir },
        { label: 'Berhenti', count: statusCounts.berhenti },
      ],
      arAging: buildAging(unpaid, now),
    };
  }

  async getReports(): Promise<ReportsSummary> {
    const now = new Date();
    const window = buildMonthWindow(now);

    const [statusCounts, activeBillable, revenueRows, addedRows, churnedRows] = await Promise.all([
      this.customers.countByStatus(),
      this.customers.findActiveBillable(),
      this.invoices.revenueByMonth(window.since),
      this.customers.countCreatedByMonth(window.since),
      this.customers.countChurnedByMonth(window.since),
    ]);

    const activeSubscribers = statusCounts.aktif;
    const totalCustomers = sumValues(statusCounts);
    const mrr = activeBillable.reduce((sum, c) => sum + c.planPriceMonthly, 0);

    const addedByKey = new Map(addedRows.map((r) => [r.month, r.count]));
    const churnedByKey = new Map(churnedRows.map((r) => [r.month, r.count]));

    return {
      revenueTrend: fillRevenue(window.months, revenueRows),
      movement: window.months.map((m) => ({
        month: m.label,
        added: addedByKey.get(m.key) ?? 0,
        churned: churnedByKey.get(m.key) ?? 0,
      })),
      arpu: activeSubscribers > 0 ? Math.round(mrr / activeSubscribers) : 0,
      churnRate: ratio(statusCounts.berhenti, totalCustomers, 0),
    };
  }
}

// --- Pure helpers -----------------------------------------------------

type MonthSlot = { key: string; label: string };

function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// The rolling window of the last MONTH_WINDOW months (oldest first) plus the
// UTC start of the earliest month, used as the `since` bound for grouped reads.
function buildMonthWindow(now: Date): { months: MonthSlot[]; since: Date } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const months = Array.from({ length: MONTH_WINDOW }, (_, i) => {
    const d = new Date(Date.UTC(year, month - (MONTH_WINDOW - 1 - i), 1));
    const m = d.getUTCMonth();
    return {
      key: `${d.getUTCFullYear()}-${String(m + 1).padStart(2, '0')}`,
      label: MONTH_LABELS[m] ?? '',
    };
  });
  return { months, since: new Date(Date.UTC(year, month - (MONTH_WINDOW - 1), 1)) };
}

// Project grouped revenue rows onto the window, zero-filling empty months and
// relabelling YYYY-MM keys to short month names for display.
function fillRevenue(
  months: MonthSlot[],
  rows: Array<{ month: string; revenue: number }>,
): Array<{ month: string; revenue: number }> {
  const byKey = new Map(rows.map((r) => [r.month, r.revenue]));
  return months.map((m) => ({ month: m.label, revenue: byKey.get(m.key) ?? 0 }));
}

// Receivable aging from unpaid invoices, bucketed by days past the due date.
// TIME-1: bucketed against the WIB calendar day, not a raw getTime() diff —
// see wib-date.ts's doc comment for why a getTime() instant diff against a
// UTC-midnight-parsed due date is off by a day right around WIB midnight.
function buildAging(unpaid: Invoice[], now: Date): Array<{ bucket: string; amount: number }> {
  const aging = { future: 0, b30: 0, b60: 0, b60plus: 0 };
  const today = wibDateString(now);
  for (const inv of unpaid) {
    const total = invoiceBalanceDue(inv);
    const days = daysBetweenDates(inv.dueDate, today);
    if (days <= 0) aging.future += total;
    else if (days <= 30) aging.b30 += total;
    else if (days <= 60) aging.b60 += total;
    else aging.b60plus += total;
  }
  return [
    { bucket: 'Belum jatuh tempo', amount: aging.future },
    { bucket: '1–30 hari', amount: aging.b30 },
    { bucket: '31–60 hari', amount: aging.b60 },
    { bucket: '> 60 hari', amount: aging.b60plus },
  ];
}

// Invoice total = plan price + late fee + tax (all whole IDR).
// Outstanding balance on an invoice: the gross total less any SLA-credit
// discount line and any partial payment already received (P3.A.4). AR
// outstanding + aging must count the balance still owed, not the gross —
// otherwise a part-paid invoice overstates receivables.
function invoiceBalanceDue(inv: Invoice): number {
  return inv.amount + inv.lateFee + inv.taxAmount - inv.discountAmount - inv.paidAmount;
}

function sumValues(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

// A ratio clamped to a fallback when the denominator is empty, rounded to
// three decimals (the precision the dashboard charts render).
function ratio(numerator: number, denominator: number, fallback: number): number {
  if (denominator <= 0) return fallback;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

// A flat sparkline at `value` (one point per window month) — used until a
// historical snapshot table exists to draw real movement.
function flat(value: number): number[] {
  return Array.from({ length: MONTH_WINDOW }, () => value);
}
