import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomersRepository } from '../customers/customers.repository';
import { NotificationsService } from '../notifications/notifications.service';
import { SecretEnforcementService } from '../router-resources/secret-enforcement.service';
import { SettingsService } from '../settings/settings.service';
import { BillingAutomationService } from './billing-automation.service';
import { InvoicesRepository } from './invoices.repository';
import { InvoicesService } from './invoices.service';

describe('BillingAutomationService', () => {
  let service: BillingAutomationService;
  let invoicesService: { run: ReturnType<typeof vi.fn> };
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let customers: {
    findById: ReturnType<typeof vi.fn>;
    setBilling: ReturnType<typeof vi.fn>;
    findActiveBillable: ReturnType<typeof vi.fn>;
  };
  let secrets: { applyDisabledForCustomer: ReturnType<typeof vi.fn> };
  let notifications: { enqueue: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    invoicesService = { run: vi.fn() };
    repo = {
      markOverduePastDue: vi.fn(),
      countOverdueAll: vi.fn(),
      countPendingDueSoon: vi.fn(),
      markRemindedOverdue: vi.fn(),
      markRemindedDueSoon: vi.fn(),
      markRemindedByIds: vi.fn(),
      customerIdsWithOverdue: vi.fn(),
      customerIdsWithPendingDueSoon: vi.fn(),
      sumUnpaidByCustomer: vi.fn(),
      existsForPeriod: vi.fn(),
    };
    customers = { findById: vi.fn(), setBilling: vi.fn(), findActiveBillable: vi.fn() };
    secrets = { applyDisabledForCustomer: vi.fn() };
    notifications = { enqueue: vi.fn() };
    // Safe defaults so the dunning dispatch is a no-op unless a test opts in.
    repo.customerIdsWithOverdue.mockResolvedValue([]);
    repo.customerIdsWithPendingDueSoon.mockResolvedValue([]);
    const settings = {
      getBillingPolicy: vi.fn().mockResolvedValue({
        pkp: true,
        ppnRate: 0.11,
        dueDays: 10,
        lateFeeIdr: 25_000,
        isolirGraceDays: 3,
      }),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        BillingAutomationService,
        { provide: InvoicesService, useValue: invoicesService },
        { provide: InvoicesRepository, useValue: repo },
        { provide: CustomersRepository, useValue: customers },
        { provide: SecretEnforcementService, useValue: secrets },
        { provide: NotificationsService, useValue: notifications },
        { provide: SettingsService, useValue: settings },
      ],
    }).compile();
    service = moduleRef.get(BillingAutomationService);
  });

  describe('isolirOverdue', () => {
    it('marks overdue then isolates only active debtors', async () => {
      repo.markOverduePastDue.mockResolvedValue(3);
      repo.customerIdsWithOverdue.mockResolvedValue(['c1', 'c2']);
      customers.findById.mockImplementation((id: string) =>
        Promise.resolve({ id, status: id === 'c1' ? 'aktif' : 'isolir', phone: null }),
      );
      repo.sumUnpaidByCustomer.mockResolvedValue(247_000);

      const result = await service.isolirOverdue();

      expect(repo.markOverduePastDue).toHaveBeenCalledWith(25_000);
      // c1 (aktif) gets isolated; c2 (already isolir) is skipped
      expect(customers.setBilling).toHaveBeenCalledTimes(1);
      // Auto-isolir is punitive (P3.A.3): records the overdue hold reason.
      expect(customers.setBilling).toHaveBeenCalledWith('c1', {
        status: 'isolir',
        outstanding: 247_000,
        holdReason: 'overdue',
      });
      // ADR-0008: isolating a debtor disables their PPPoE secret on the router.
      expect(secrets.applyDisabledForCustomer).toHaveBeenCalledTimes(1);
      expect(secrets.applyDisabledForCustomer).toHaveBeenCalledWith('c1', true);
      expect(result).toEqual({ markedOverdue: 3, isolated: 1 });
    });

    // ADR-0012: the exact "overdue → isolir surprise" this ADR exists to
    // prevent — the newly-isolated customer must be told via WhatsApp.
    it('enqueues an isolir notice to each newly-isolated customer with a phone', async () => {
      repo.markOverduePastDue.mockResolvedValue(1);
      repo.customerIdsWithOverdue.mockResolvedValue(['c1', 'c2']);
      customers.findById.mockImplementation((id: string) =>
        Promise.resolve(
          id === 'c1'
            ? { id, status: 'aktif', phone: '0812', fullName: 'Budi' }
            : { id, status: 'aktif', phone: null, fullName: 'Tanpa Telepon' },
        ),
      );
      repo.sumUnpaidByCustomer.mockResolvedValue(300_000);

      await service.isolirOverdue();

      // c1 has a phone -> enqueued; c2 has none -> skipped (still isolated).
      expect(notifications.enqueue).toHaveBeenCalledTimes(1);
      expect(notifications.enqueue).toHaveBeenCalledWith(
        { event: 'isolir', to: '0812', vars: { nama: 'Budi', jumlah: 'Rp300.000' } },
        expect.stringMatching(/^isolir:c1:/),
      );
      // c2 is still isolated even without a phone to notify.
      expect(customers.setBilling).toHaveBeenCalledTimes(2);
      expect(secrets.applyDisabledForCustomer).toHaveBeenCalledTimes(2);
    });

    it('does not fail the isolir run when the notification enqueue rejects (best-effort)', async () => {
      repo.markOverduePastDue.mockResolvedValue(1);
      repo.customerIdsWithOverdue.mockResolvedValue(['c1']);
      customers.findById.mockResolvedValue({
        id: 'c1',
        status: 'aktif',
        phone: '0812',
        fullName: 'Budi',
      });
      repo.sumUnpaidByCustomer.mockResolvedValue(300_000);
      notifications.enqueue.mockRejectedValue(new Error('queue down'));

      const result = await service.isolirOverdue();

      // The isolir enforcement (status flip + router secret disable) still
      // completes even though the notice failed to enqueue.
      expect(result.isolated).toBe(1);
      expect(secrets.applyDisabledForCustomer).toHaveBeenCalledWith('c1', true);
    });
  });

  describe('remind', () => {
    it('reminds explicit ids when provided', async () => {
      repo.markRemindedByIds.mockResolvedValue(2);
      const result = await service.remind({ invoiceIds: ['a', 'b'] });
      expect(repo.markRemindedByIds).toHaveBeenCalledWith(['a', 'b']);
      expect(repo.markRemindedOverdue).not.toHaveBeenCalled();
      expect(result).toEqual({ reminded: 2, channel: 'whatsapp' });
    });

    // ADR-0012: dunning must actually send — enqueue one WhatsApp per overdue
    // debtor (idempotent per customer + event + month), skipping phoneless rows.
    it('enqueues a WhatsApp dunning to each overdue debtor with a phone', async () => {
      repo.markRemindedOverdue.mockResolvedValue(2);
      repo.customerIdsWithOverdue.mockResolvedValue(['c1', 'c2']);
      customers.findById.mockImplementation((id: string) =>
        Promise.resolve(
          id === 'c1'
            ? { id, phone: '0812', fullName: 'Budi' }
            : { id, phone: null, fullName: 'X' },
        ),
      );
      repo.sumUnpaidByCustomer.mockResolvedValue(247_000);

      await service.remind({});

      // c1 has a phone -> enqueued with real vars; c2 has none -> skipped.
      expect(notifications.enqueue).toHaveBeenCalledTimes(1);
      expect(notifications.enqueue).toHaveBeenCalledWith(
        { event: 'overdue', to: '0812', vars: { nama: 'Budi', jumlah: 'Rp247.000' } },
        expect.stringMatching(/^dun:overdue:c1:/),
      );
    });

    it('reminds all overdue when no ids given', async () => {
      repo.markRemindedOverdue.mockResolvedValue(5);
      const result = await service.remind({});
      expect(repo.markRemindedOverdue).toHaveBeenCalled();
      expect(result.reminded).toBe(5);
    });
  });

  it('schedulerPreview counts to-bill (active without current invoice), dunning + isolir', async () => {
    customers.findActiveBillable.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    repo.existsForPeriod.mockImplementation((id: string) => Promise.resolve(id === 'c2'));
    repo.countPendingDueSoon.mockResolvedValue(4);
    repo.countOverdueAll.mockResolvedValue(6);
    repo.customerIdsWithOverdue.mockResolvedValue(['c1']);
    customers.findById.mockResolvedValue({ id: 'c1', status: 'aktif' });

    const result = await service.schedulerPreview();
    expect(result).toEqual({ toBill: 1, toRemindUpcoming: 4, toRemindOverdue: 6, toIsolir: 1 });
  });

  it('schedulerRun chains run -> overdue -> dun -> isolir', async () => {
    invoicesService.run.mockResolvedValue({ period: '2026-06', created: 7 });
    repo.markOverduePastDue.mockResolvedValue(2);
    repo.markRemindedDueSoon.mockResolvedValue(3);
    repo.markRemindedOverdue.mockResolvedValue(2);
    repo.customerIdsWithOverdue.mockResolvedValue([]);

    const result = await service.schedulerRun();
    expect(result).toEqual({
      period: '2026-06',
      created: 7,
      remindedUpcoming: 3,
      remindedOverdue: 2,
      isolated: 0,
    });
  });
});
