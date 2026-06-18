import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoutersRepository } from '../routers/routers.repository';
import { SecretsRepository } from './secrets.repository';
import type { SessionListFilter } from './sessions.service';
import { SessionsService } from './sessions.service';

const ROUTER_ID = '00000000-0000-0000-0000-00000000a101';

const DEFAULT_FILTER: SessionListFilter = { limit: 50, offset: 0 };

// Two secrets with UUIDs that produce deterministic, testable synthesis values.
const SECRET_ENABLED = {
  id: '00000000-0000-0000-0000-00000000c101',
  routerId: ROUTER_ID,
  username: 'cust1',
  profileId: '00000000-0000-0000-0000-00000000b101',
  profileName: 'Home20',
  customerId: 'cust-uuid-1',
  customerName: 'Budi Santoso',
  disabled: false,
  comment: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const SECRET_DISABLED = {
  ...SECRET_ENABLED,
  id: '00000000-0000-0000-0000-00000000c102',
  username: 'cust2',
  disabled: true,
};
const SECRET_ALPHA = {
  ...SECRET_ENABLED,
  id: '00000000-0000-0000-0000-00000000c201',
  username: 'alpha',
  profileName: 'Pro100',
  customerId: 'cust-uuid-2',
  customerName: 'Ahmad Fauzi',
};

describe('SessionsService', () => {
  let service: SessionsService;
  let secrets: { listByRouter: ReturnType<typeof vi.fn> };
  let routers: { findById: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    secrets = { listByRouter: vi.fn() };
    routers = { findById: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SessionsService,
        { provide: SecretsRepository, useValue: secrets },
        { provide: RoutersRepository, useValue: routers },
      ],
    }).compile();
    service = moduleRef.get(SessionsService);
  });

  it('derives one session per enabled secret (skips disabled)', async () => {
    routers.findById.mockResolvedValue({ id: ROUTER_ID });
    secrets.listByRouter.mockResolvedValue({
      items: [SECRET_ENABLED, SECRET_DISABLED],
      total: 2,
    });
    const result = await service.list(ROUTER_ID, DEFAULT_FILTER);
    expect(result.total).toBe(1);
    expect(result.items[0]?.username).toBe('cust1');
    expect(result.items[0]?.address).toMatch(/^100\.64\.\d+\.\d+$/);
    expect(result.items[0]?.callerId).toMatch(/^AA:BB:/);
  });

  it('denormalises customerId, customerName, profileName from secret', async () => {
    routers.findById.mockResolvedValue({ id: ROUTER_ID });
    secrets.listByRouter.mockResolvedValue({ items: [SECRET_ENABLED], total: 1 });
    const result = await service.list(ROUTER_ID, DEFAULT_FILTER);
    const sess = result.items[0];
    expect(sess?.customerId).toBe('cust-uuid-1');
    expect(sess?.customerName).toBe('Budi Santoso');
    expect(sess?.profileName).toBe('Home20');
  });

  describe('q filter', () => {
    beforeEach(() => {
      routers.findById.mockResolvedValue({ id: ROUTER_ID });
      secrets.listByRouter.mockResolvedValue({
        items: [SECRET_ENABLED, SECRET_ALPHA],
        total: 2,
      });
    });

    it('filters by username substring (case-insensitive)', async () => {
      const result = await service.list(ROUTER_ID, { ...DEFAULT_FILTER, q: 'CUST1' });
      expect(result.total).toBe(1);
      expect(result.items[0]?.username).toBe('cust1');
    });

    it('filters by customerName substring', async () => {
      const result = await service.list(ROUTER_ID, { ...DEFAULT_FILTER, q: 'Ahmad' });
      expect(result.total).toBe(1);
      expect(result.items[0]?.username).toBe('alpha');
    });

    it('filters by address substring', async () => {
      // Both sessions have 100.64.x.y so filtering by "100.64" returns all.
      const result = await service.list(ROUTER_ID, { ...DEFAULT_FILTER, q: '100.64' });
      expect(result.total).toBe(2);
    });

    it('returns empty when q matches nothing', async () => {
      const result = await service.list(ROUTER_ID, { ...DEFAULT_FILTER, q: 'zzz-no-match' });
      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
    });
  });

  describe('sort', () => {
    const twoItems = [SECRET_ENABLED, SECRET_ALPHA];

    beforeEach(() => {
      routers.findById.mockResolvedValue({ id: ROUTER_ID });
      secrets.listByRouter.mockResolvedValue({ items: twoItems, total: 2 });
    });

    it('defaults to asc username when sort is absent', async () => {
      const result = await service.list(ROUTER_ID, DEFAULT_FILTER);
      const usernames = result.items.map((s) => s.username);
      expect(usernames).toEqual([...usernames].sort());
    });

    it('sort=username desc reverses order', async () => {
      const result = await service.list(ROUTER_ID, {
        ...DEFAULT_FILTER,
        sort: 'username',
        order: 'desc',
      });
      const usernames = result.items.map((s) => s.username);
      expect(usernames).toEqual([...usernames].sort().reverse());
    });

    it('sort=customerName asc', async () => {
      const result = await service.list(ROUTER_ID, {
        ...DEFAULT_FILTER,
        sort: 'customerName',
        order: 'asc',
      });
      expect(result.items[0]?.customerName).toBe('Ahmad Fauzi');
    });

    it('sort=profileName asc', async () => {
      const result = await service.list(ROUTER_ID, {
        ...DEFAULT_FILTER,
        sort: 'profileName',
        order: 'asc',
      });
      expect(result.items[0]?.profileName).toBe('Home20');
    });

    it('unknown sort key falls back to username asc', async () => {
      const result = await service.list(ROUTER_ID, {
        ...DEFAULT_FILTER,
        sort: 'uptime', // not in whitelist
        order: 'asc',
      });
      const usernames = result.items.map((s) => s.username);
      expect(usernames).toEqual([...usernames].sort());
    });
  });

  describe('pagination', () => {
    const threeSecrets = [
      SECRET_ALPHA,
      SECRET_ENABLED,
      { ...SECRET_ENABLED, id: '00000000-0000-0000-0000-00000000c301', username: 'zeta' },
    ];

    beforeEach(() => {
      routers.findById.mockResolvedValue({ id: ROUTER_ID });
      secrets.listByRouter.mockResolvedValue({ items: threeSecrets, total: 3 });
    });

    it('total reflects filtered count before paging', async () => {
      const result = await service.list(ROUTER_ID, { ...DEFAULT_FILTER, limit: 1, offset: 0 });
      expect(result.total).toBe(3);
      expect(result.items).toHaveLength(1);
    });

    it('offset slices correctly', async () => {
      const page1 = await service.list(ROUTER_ID, {
        ...DEFAULT_FILTER,
        sort: 'username',
        order: 'asc',
        limit: 1,
        offset: 0,
      });
      const page2 = await service.list(ROUTER_ID, {
        ...DEFAULT_FILTER,
        sort: 'username',
        order: 'asc',
        limit: 1,
        offset: 1,
      });
      expect(page1.items[0]?.username).not.toBe(page2.items[0]?.username);
    });
  });

  describe('address/uptime stability across pages', () => {
    it('same secret yields same address on page 1 and page 2', async () => {
      routers.findById.mockResolvedValue({ id: ROUTER_ID });
      secrets.listByRouter.mockResolvedValue({
        items: [SECRET_ALPHA, SECRET_ENABLED],
        total: 2,
      });

      const page1 = await service.list(ROUTER_ID, {
        ...DEFAULT_FILTER,
        sort: 'username',
        order: 'asc',
        limit: 1,
        offset: 0,
      });
      const page2 = await service.list(ROUTER_ID, {
        ...DEFAULT_FILTER,
        sort: 'username',
        order: 'asc',
        limit: 1,
        offset: 1,
      });

      // The second session on page2 is the same secret as was on position 2 overall.
      // Re-fetch both in one call to compare:
      const full = await service.list(ROUTER_ID, DEFAULT_FILTER);
      const fromPage1 = full.items.find((s) => s.id === page1.items[0]?.id);
      const fromFull = page1.items[0];
      expect(fromPage1?.address).toBe(fromFull?.address);
      expect(fromPage1?.uptime).toBe(fromFull?.uptime);
      // page2 item also matches
      const fromPage2Full = full.items.find((s) => s.id === page2.items[0]?.id);
      expect(fromPage2Full?.address).toBe(page2.items[0]?.address);
    });
  });

  it('list / disconnect 404 on unknown router', async () => {
    routers.findById.mockResolvedValue(null);
    await expect(service.list(ROUTER_ID, DEFAULT_FILTER)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.disconnect(ROUTER_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});
