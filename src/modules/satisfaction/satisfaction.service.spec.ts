import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomersRepository } from '../customers/customers.repository';
import { TicketsService } from '../tickets/tickets.service';
import { SatisfactionService } from './satisfaction.service';

describe('SatisfactionService', () => {
  let service: SatisfactionService;
  let customers: { countAll: ReturnType<typeof vi.fn>; findAtRisk: ReturnType<typeof vi.fn> };
  let tickets: { list: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    customers = { countAll: vi.fn(), findAtRisk: vi.fn() };
    tickets = { list: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SatisfactionService,
        { provide: CustomersRepository, useValue: customers },
        { provide: TicketsService, useValue: tickets },
      ],
    }).compile();
    service = moduleRef.get(SatisfactionService);
  });

  it('aggregates CSAT, NPS, churn and recent feedback', async () => {
    tickets.list.mockResolvedValue({
      items: [
        {
          id: 't1',
          customerId: '00000000-0000-0000-0000-0000000000c1',
          customerName: 'Budi',
          createdAt: '2026-06-15T00:00:00.000Z',
        },
        {
          id: 't2',
          customerId: null,
          customerName: 'NOC Device',
          createdAt: '2026-06-14T00:00:00.000Z',
        },
      ],
      total: 4,
    });
    customers.countAll.mockResolvedValue(11);
    customers.findAtRisk.mockResolvedValue([
      { id: 'c1', fullName: 'Iwan', status: 'isolir', outstanding: 0 },
      { id: 'c2', fullName: 'Ani', status: 'aktif', outstanding: 50_000 },
    ]);

    const result = await service.get();

    // CSAT: 4 resolved -> ratings 3,4,5,3 -> avg 3.75 -> 3.8
    expect(result.csat).toEqual({ avg: 3.8, count: 4 });

    // NPS over 11 subscribers: scores (i*7)%11 -> promoters 2, passives 2, detractors 7
    expect(result.nps).toEqual({ score: -45, promoters: 2, passives: 2, detractors: 7, total: 11 });

    // churn: 2 at-risk of 11 -> 18.2%; reasons + riskPct by status
    expect(result.churn.rate).toBeCloseTo(18.2);
    expect(result.churn.atRisk).toEqual([
      { customerId: 'c1', customerName: 'Iwan', reason: 'Terisolir', riskPct: 80 },
      { customerId: 'c2', customerName: 'Ani', reason: 'Tunggakan tagihan', riskPct: 55 },
    ]);

    // recent feedback: 2 items, ratings 3 & 4; ticket with null customerId omits it
    expect(result.recentFeedback).toHaveLength(2);
    expect(result.recentFeedback[0]).toEqual({
      id: 't1-fb',
      customerId: '00000000-0000-0000-0000-0000000000c1',
      customerName: 'Budi',
      rating: 3,
      comment: 'Pemasangan cepat dan rapi',
      at: '2026-06-15T00:00:00.000Z',
    });
    expect(result.recentFeedback[1]).not.toHaveProperty('customerId');
  });

  it('returns zeroed aggregates when there is no data', async () => {
    tickets.list.mockResolvedValue({ items: [], total: 0 });
    customers.countAll.mockResolvedValue(0);
    customers.findAtRisk.mockResolvedValue([]);
    const result = await service.get();
    expect(result.csat).toEqual({ avg: 0, count: 0 });
    expect(result.nps.score).toBe(0);
    expect(result.churn).toEqual({ rate: 0, atRisk: [] });
    expect(result.recentFeedback).toEqual([]);
  });
});
