import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomersRepository } from '../customers/customers.repository';
import { DevicesRepository } from '../devices/devices.repository';
import { InvoicesRepository } from '../invoices/invoices.repository';
import { LeadsRepository } from '../leads/leads.repository';
import { MonitoringRepository } from '../monitoring/monitoring.repository';
import { SlaCreditsRepository } from '../sla-credits/sla-credits.repository';
import { TicketsRepository } from '../tickets/tickets.repository';
import { AnalyticsService } from './analytics.service';

// Pin "now" to mid-June 2026 so the rolling six-month window is Jan–Jun.
const NOW = new Date('2026-06-16T00:00:00.000Z');

const statusCounts = { prospek: 5, instalasi: 3, aktif: 100, isolir: 8, berhenti: 4 };

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let customers: Record<string, ReturnType<typeof vi.fn>>;
  let invoices: Record<string, ReturnType<typeof vi.fn>>;
  let tickets: Record<string, ReturnType<typeof vi.fn>>;
  let devices: Record<string, ReturnType<typeof vi.fn>>;
  let leads: Record<string, ReturnType<typeof vi.fn>>;
  let monitoring: Record<string, ReturnType<typeof vi.fn>>;
  let slaCredits: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    customers = {
      countByStatus: vi.fn().mockResolvedValue(statusCounts),
      countCreatedSince: vi.fn().mockResolvedValue(12),
      countAtRisk: vi.fn().mockResolvedValue(15),
      findActiveBillable: vi.fn().mockResolvedValue([
        { id: 'c1', fullName: 'A', planPriceMonthly: 150_000 },
        { id: 'c2', fullName: 'B', planPriceMonthly: 100_000 },
      ]),
      countCreatedByMonth: vi.fn().mockResolvedValue([
        { month: '2026-04', count: 10 },
        { month: '2026-06', count: 12 },
      ]),
      countChurnedByMonth: vi.fn().mockResolvedValue([{ month: '2026-05', count: 2 }]),
    };
    invoices = {
      listUnpaid: vi.fn().mockResolvedValue([
        // future (not yet due)
        {
          status: 'pending',
          amount: 100_000,
          lateFee: 0,
          taxAmount: 11_000,
          discountAmount: 0,
          paidAmount: 0,
          dueDate: '2026-06-30',
        },
        // 15 days overdue -> 1–30 bucket
        {
          status: 'overdue',
          amount: 100_000,
          lateFee: 5_000,
          taxAmount: 11_000,
          discountAmount: 0,
          paidAmount: 0,
          dueDate: '2026-06-01',
        },
        // ~107 days overdue -> > 60 bucket
        {
          status: 'overdue',
          amount: 200_000,
          lateFee: 10_000,
          taxAmount: 22_000,
          discountAmount: 0,
          paidAmount: 0,
          dueDate: '2026-03-01',
        },
      ]),
      revenueByMonth: vi.fn().mockResolvedValue([
        { month: '2026-05', revenue: 42_000_000 },
        { month: '2026-06', revenue: 50_000_000 },
      ]),
    };
    tickets = {
      countByStatus: vi
        .fn()
        .mockResolvedValue({ open: 9, in_progress: 5, resolved: 31, breached: 2 }),
    };
    devices = {
      countByStatus: vi.fn().mockResolvedValue({ online: 142, degraded: 5, offline: 3 }),
    };
    leads = {
      activePipeline: vi.fn().mockResolvedValue({ value: 36_000_000, count: 4 }),
    };
    monitoring = { countUnacknowledged: vi.fn().mockResolvedValue(6) };
    slaCredits = { countPending: vi.fn().mockResolvedValue(3) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: CustomersRepository, useValue: customers },
        { provide: InvoicesRepository, useValue: invoices },
        { provide: TicketsRepository, useValue: tickets },
        { provide: DevicesRepository, useValue: devices },
        { provide: LeadsRepository, useValue: leads },
        { provide: MonitoringRepository, useValue: monitoring },
        { provide: SlaCreditsRepository, useValue: slaCredits },
      ],
    }).compile();
    service = moduleRef.get(AnalyticsService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getDashboard', () => {
    it('derives KPIs, command center, mix and aging from the source modules', async () => {
      const result = await service.getDashboard();

      // Lifecycle KPIs straight from the status counts.
      expect(result.activeSubscribers).toBe(100);
      expect(result.isolatedSubscribers).toBe(8);
      expect(result.newThisMonth).toBe(12);
      // MRR = sum of active subscribers' plan price.
      expect(result.mrr).toBe(250_000);

      // Receivables: all unpaid totals, the overdue slice, and the count.
      expect(result.arOutstanding).toBe(459_000);
      expect(result.overdueAmount).toBe(348_000);
      expect(result.overdueCount).toBe(2);

      // Tickets: open count + compliance over terminal tickets (31/33).
      expect(result.openTickets).toBe(9);
      expect(result.slaCompliance).toBe(0.939);
      expect(result.ticketsByStatus).toEqual([
        { label: 'Terbuka', count: 9 },
        { label: 'Diproses', count: 5 },
        { label: 'Selesai', count: 31 },
      ]);

      // Devices online / total from the status counts.
      expect(result.devicesOnline).toBe(142);
      expect(result.devicesTotal).toBe(150);

      // Six-month revenue window, zero-filled with short month labels.
      expect(result.revenueTrend).toEqual([
        { month: 'Jan', revenue: 0 },
        { month: 'Feb', revenue: 0 },
        { month: 'Mar', revenue: 0 },
        { month: 'Apr', revenue: 0 },
        { month: 'May', revenue: 42_000_000 },
        { month: 'Jun', revenue: 50_000_000 },
      ]);

      // Sparklines flat-line at the current value (no history table yet).
      expect(result.subscriberTrend).toEqual([100, 100, 100, 100, 100, 100]);
      expect(result.isolatedTrend).toEqual([8, 8, 8, 8, 8, 8]);
      expect(result.arTrend).toEqual([459_000, 459_000, 459_000, 459_000, 459_000, 459_000]);

      // Command center rollup; odpFull is 0 until the topology module exists.
      expect(result.commandCenter).toEqual({
        pipelineValue: 36_000_000,
        activeLeads: 4,
        churnRate: 0.125,
        slaCreditsPending: 3,
        devicesAlert: 6,
        odpFull: 0,
      });

      expect(result.customerMix).toEqual([
        { label: 'Prospek', count: 5 },
        { label: 'Instalasi', count: 3 },
        { label: 'Aktif', count: 100 },
        { label: 'Isolir', count: 8 },
        { label: 'Berhenti', count: 4 },
      ]);

      // Aging buckets: future / 1–30 / 31–60 / > 60.
      expect(result.arAging).toEqual([
        { bucket: 'Belum jatuh tempo', amount: 111_000 },
        { bucket: '1–30 hari', amount: 116_000 },
        { bucket: '31–60 hari', amount: 0 },
        { bucket: '> 60 hari', amount: 232_000 },
      ]);
    });

    it('reports full SLA compliance and zero churn when there is no data', async () => {
      tickets.countByStatus.mockResolvedValue({
        open: 0,
        in_progress: 0,
        resolved: 0,
        breached: 0,
      });
      customers.countByStatus.mockResolvedValue({
        prospek: 0,
        instalasi: 0,
        aktif: 0,
        isolir: 0,
        berhenti: 0,
      });
      customers.countAtRisk.mockResolvedValue(0);

      const result = await service.getDashboard();

      expect(result.slaCompliance).toBe(1);
      expect(result.commandCenter.churnRate).toBe(0);
    });
  });

  describe('getReports', () => {
    it('derives revenue, movement, ARPU and churn rate', async () => {
      const result = await service.getReports();

      expect(result.revenueTrend).toEqual([
        { month: 'Jan', revenue: 0 },
        { month: 'Feb', revenue: 0 },
        { month: 'Mar', revenue: 0 },
        { month: 'Apr', revenue: 0 },
        { month: 'May', revenue: 42_000_000 },
        { month: 'Jun', revenue: 50_000_000 },
      ]);
      expect(result.movement).toEqual([
        { month: 'Jan', added: 0, churned: 0 },
        { month: 'Feb', added: 0, churned: 0 },
        { month: 'Mar', added: 0, churned: 0 },
        { month: 'Apr', added: 10, churned: 0 },
        { month: 'May', added: 0, churned: 2 },
        { month: 'Jun', added: 12, churned: 0 },
      ]);
      // ARPU = MRR / active subscribers = 250000 / 100.
      expect(result.arpu).toBe(2_500);
      // Churn rate = berhenti / total = 4 / 120.
      expect(result.churnRate).toBe(0.033);
    });
  });
});
