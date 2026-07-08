import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { AcsService } from '../acs/acs.service';
import { AnnouncementsService } from '../announcements/announcements.service';
import { CustomersService } from '../customers/customers.service';
import type { CustomerResponse } from '../customers/dto/customer-response.dto';
import { InvoicesService } from '../invoices/invoices.service';
import { PaymentIntentsService } from '../invoices/payment-intents.service';
import { TicketsService } from '../tickets/tickets.service';
import { UsageService } from '../usage/usage.service';
import { PortalService } from './portal.service';

const CUSTOMER_ID = '00000000-0000-0000-0000-0000000000c1';

const user: AuthUser = {
  id: '00000000-0000-0000-0000-0000000000u1',
  email: 'budi@example.com',
  fullName: 'Budi Santoso',
  role: 'customer',
  resellerId: null,
};

function customer(over: Partial<CustomerResponse> = {}): CustomerResponse {
  return {
    id: CUSTOMER_ID,
    customerNo: 'CUST-9001',
    fullName: 'Budi Santoso',
    phone: '0811',
    email: 'budi@example.com',
    address: 'Jl. Mawar',
    areaId: null,
    areaName: null,
    planId: '00000000-0000-0000-0000-0000000000p1',
    planName: 'Home 50',
    status: 'aktif',
    holdReason: null,
    outstanding: 0,
    billingAnchorDay: null,
    npwp: null,
    ktp: null,
    consentAt: null,
    resellerName: null,
    connection: null,
    joinedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('PortalService', () => {
  let service: PortalService;
  let customers: Record<string, ReturnType<typeof vi.fn>>;
  let invoices: Record<string, ReturnType<typeof vi.fn>>;
  let tickets: Record<string, ReturnType<typeof vi.fn>>;
  let intents: Record<string, ReturnType<typeof vi.fn>>;
  let usage: Record<string, ReturnType<typeof vi.fn>>;
  let acs: Record<string, ReturnType<typeof vi.fn>>;
  let announcements: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    customers = { resolveForPortal: vi.fn().mockResolvedValue(customer()) };
    invoices = {
      invoicesByCustomer: vi.fn().mockResolvedValue([{ id: 'inv-1' }]),
      paymentsByCustomer: vi.fn().mockResolvedValue([{ id: 'pay-1' }]),
    };
    tickets = {
      listByCustomer: vi.fn().mockResolvedValue([{ id: 'tkt-1' }]),
      create: vi.fn(),
      findByIdForCustomer: vi.fn(),
      addComment: vi.fn(),
      listEvents: vi.fn(),
      submitCsat: vi.fn(),
    };
    intents = {
      createForCustomer: vi.fn().mockResolvedValue({ id: 'int-1', status: 'pending' }),
      findForCustomer: vi.fn().mockResolvedValue({ id: 'int-1', status: 'pending' }),
      // Only the still-resumable (pending, not expired) intent is returned —
      // the paid/expired filtering itself is the repository's job (covered
      // by payment-intents.repository.int-spec.ts); here we only assert
      // PortalService plumbs whatever the service hands back into `/me`.
      pendingForCustomer: vi.fn().mockResolvedValue([{ id: 'int-pending', status: 'pending' }]),
    };
    usage = { forCustomer: vi.fn() };
    acs = { wifiForCustomer: vi.fn(), setWifiForCustomer: vi.fn() };
    announcements = { listActive: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PortalService,
        { provide: CustomersService, useValue: customers },
        { provide: InvoicesService, useValue: invoices },
        { provide: TicketsService, useValue: tickets },
        { provide: PaymentIntentsService, useValue: intents },
        { provide: UsageService, useValue: usage },
        { provide: AcsService, useValue: acs },
        { provide: AnnouncementsService, useValue: announcements },
      ],
    }).compile();
    service = moduleRef.get(PortalService);
  });

  describe('getMe', () => {
    it('resolves the customer by session email and aggregates their data', async () => {
      const snapshot = await service.getMe(user);

      expect(customers.resolveForPortal).toHaveBeenCalledWith(user);
      expect(invoices.invoicesByCustomer).toHaveBeenCalledWith(CUSTOMER_ID);
      expect(invoices.paymentsByCustomer).toHaveBeenCalledWith(CUSTOMER_ID);
      expect(tickets.listByCustomer).toHaveBeenCalledWith(CUSTOMER_ID);
      expect(snapshot.customer.id).toBe(CUSTOMER_ID);
      expect(snapshot.invoices).toHaveLength(1);
      expect(snapshot.payments).toHaveLength(1);
      expect(snapshot.tickets).toHaveLength(1);
    });

    it('includes pendingIntents (P3.C.3), scoped to the resolved customer', async () => {
      const snapshot = await service.getMe(user);

      expect(intents.pendingForCustomer).toHaveBeenCalledWith(CUSTOMER_ID);
      expect(snapshot.pendingIntents).toEqual([{ id: 'int-pending', status: 'pending' }]);
    });

    it('excludes paid/expired intents — only what the intents service reports as pending is surfaced', async () => {
      intents.pendingForCustomer.mockResolvedValueOnce([]);

      const snapshot = await service.getMe(user);

      expect(snapshot.pendingIntents).toEqual([]);
    });
  });

  describe('pay intents (P0.4)', () => {
    it('creates a charge scoped to the resolved customer', async () => {
      const result = await service.createPayIntent(user, {
        invoiceId: 'inv-1',
        channel: 'qris',
      });

      expect(customers.resolveForPortal).toHaveBeenCalledWith(user);
      expect(intents.createForCustomer).toHaveBeenCalledWith(CUSTOMER_ID, {
        invoiceId: 'inv-1',
        channel: 'qris',
      });
      expect(result).toEqual({ id: 'int-1', status: 'pending' });
    });

    // SEC-H1 interim fix: the portal may only poll an intent's status —
    // there is no service method left that can settle it on the customer's
    // behalf.
    it('polls the status of a charge scoped to the resolved customer, never settling it', async () => {
      const result = await service.getPayIntent(user, 'int-1');

      expect(intents.findForCustomer).toHaveBeenCalledWith(CUSTOMER_ID, 'int-1');
      expect(result).toEqual({ id: 'int-1', status: 'pending' });
    });
  });

  describe('reportIssue', () => {
    it('opens a medium-priority ticket on the resolved customer account, threading category/photoUrl', async () => {
      await service.reportIssue(user, {
        subject: 'Internet mati sejak pagi',
        category: 'koneksi_putus',
        photoUrl: 'https://cdn.example.com/photo.jpg',
      });

      expect(tickets.create).toHaveBeenCalledWith(
        {
          subject: 'Internet mati sejak pagi',
          customerName: 'Budi Santoso',
          priority: 'medium',
          category: 'koneksi_putus',
          photoUrl: 'https://cdn.example.com/photo.jpg',
        },
        'Budi Santoso',
      );
    });
  });

  describe('getTicketDetail (P3.C.2)', () => {
    it('returns the ticket + its timeline when owned by the resolved customer', async () => {
      tickets.findByIdForCustomer.mockResolvedValue({ id: 'tkt-1', status: 'resolved' });
      tickets.listEvents.mockResolvedValue({
        items: [{ id: 'evt-1', kind: 'created' }],
        total: 1,
      });

      const detail = await service.getTicketDetail(user, 'tkt-1');

      expect(tickets.findByIdForCustomer).toHaveBeenCalledWith('tkt-1', CUSTOMER_ID);
      expect(tickets.listEvents).toHaveBeenCalledWith('tkt-1');
      expect(detail.events).toEqual([{ id: 'evt-1', kind: 'created' }]);
    });

    it('404s when the ticket does not belong to the resolved customer (IDOR guard)', async () => {
      tickets.findByIdForCustomer.mockResolvedValue(null);
      await expect(service.getTicketDetail(user, 'not-mine')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(tickets.listEvents).not.toHaveBeenCalled();
    });
  });

  describe('addTicketComment (P3.C.2)', () => {
    it('adds a comment once ownership is confirmed', async () => {
      tickets.findByIdForCustomer.mockResolvedValue({ id: 'tkt-1' });

      await service.addTicketComment(user, 'tkt-1', { body: 'Masih belum nyala' });

      expect(tickets.addComment).toHaveBeenCalledWith(
        'tkt-1',
        { body: 'Masih belum nyala' },
        'Budi Santoso',
      );
    });

    it('404s instead of commenting on a ticket owned by another customer', async () => {
      tickets.findByIdForCustomer.mockResolvedValue(null);
      await expect(
        service.addTicketComment(user, 'not-mine', { body: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tickets.addComment).not.toHaveBeenCalled();
    });
  });

  describe('submitTicketCsat (P3.C.2)', () => {
    it('submits the rating once ownership is confirmed', async () => {
      tickets.findByIdForCustomer.mockResolvedValue({ id: 'tkt-1', status: 'resolved' });
      tickets.submitCsat.mockResolvedValue({ id: 'tkt-1', csatRating: 5 });

      const result = await service.submitTicketCsat(user, 'tkt-1', { rating: 5, comment: 'Puas' });

      expect(tickets.submitCsat).toHaveBeenCalledWith(
        'tkt-1',
        { rating: 5, comment: 'Puas' },
        'Budi Santoso',
      );
      expect(result.csatRating).toBe(5);
    });

    it('defaults a missing comment to null', async () => {
      tickets.findByIdForCustomer.mockResolvedValue({ id: 'tkt-1' });
      tickets.submitCsat.mockResolvedValue({ id: 'tkt-1', csatRating: 4 });

      await service.submitTicketCsat(user, 'tkt-1', { rating: 4 });

      expect(tickets.submitCsat).toHaveBeenCalledWith(
        'tkt-1',
        { rating: 4, comment: null },
        'Budi Santoso',
      );
    });

    it('404s instead of rating a ticket owned by another customer (IDOR guard)', async () => {
      tickets.findByIdForCustomer.mockResolvedValue(null);
      await expect(
        service.submitTicketCsat(user, 'not-mine', { rating: 5 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tickets.submitCsat).not.toHaveBeenCalled();
    });
  });

  // --- self-care: usage / WiFi / announcements (P3.C.4) ---

  describe('getUsage', () => {
    it('resolves the caller and forwards their own customer id to UsageService', async () => {
      usage.forCustomer.mockResolvedValue({ customerId: CUSTOMER_ID, usedGb: 320 });
      const result = await service.getUsage(user);
      expect(customers.resolveForPortal).toHaveBeenCalledWith(user);
      expect(usage.forCustomer).toHaveBeenCalledWith(CUSTOMER_ID);
      expect(result).toEqual({ customerId: CUSTOMER_ID, usedGb: 320 });
    });

    it('propagates a 404 from UsageService (customer not in the provisioned set)', async () => {
      usage.forCustomer.mockRejectedValue(new NotFoundException('not found'));
      await expect(service.getUsage(user)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getWifi', () => {
    it('resolves the caller by session, then reads the device by fullName (not a client-supplied id)', async () => {
      acs.wifiForCustomer.mockResolvedValue({ serial: 'ZTEG1', model: 'ZTE F670L', ssid: null });
      const result = await service.getWifi(user);
      expect(acs.wifiForCustomer).toHaveBeenCalledWith('Budi Santoso');
      expect(result).toEqual({ serial: 'ZTEG1', model: 'ZTE F670L', ssid: null });
    });
  });

  describe('updateWifi', () => {
    it('resolves the caller, then forwards ssid/password scoped to their own fullName', async () => {
      acs.setWifiForCustomer.mockResolvedValue({ ok: true, ssid: 'RumahBudi_5G' });
      const result = await service.updateWifi(user, {
        ssid: 'RumahBudi_5G',
        password: 'supersecret',
      });
      expect(acs.setWifiForCustomer).toHaveBeenCalledWith(
        'Budi Santoso',
        'RumahBudi_5G',
        'supersecret',
      );
      expect(result).toEqual({ ok: true, ssid: 'RumahBudi_5G' });
    });
  });

  describe('getAnnouncements', () => {
    it('returns the active feed as-is, unscoped (same for every customer)', async () => {
      announcements.listActive.mockResolvedValue([{ id: 'a1', severity: 'outage' }]);
      const result = await service.getAnnouncements();
      expect(result).toEqual([{ id: 'a1', severity: 'outage' }]);
    });
  });
});
