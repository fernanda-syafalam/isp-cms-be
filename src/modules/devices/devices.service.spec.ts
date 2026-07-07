import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Device } from '../../infrastructure/database/schema/devices.schema';
import { DevicesRepository } from './devices.repository';
import { DevicesService } from './devices.service';

const onu: Device = {
  id: '00000000-0000-0000-0000-0000000000d1',
  name: 'ONU-0001',
  type: 'onu',
  ipAddress: '100.64.100.2',
  status: 'online',
  uptimeHours: 2_160,
  rxPower: -18.5,
  areaName: 'Jepara',
  lastSeenAt: new Date('2026-06-15T00:00:00.000Z'),
  topologyNodeId: null,
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: new Date('2026-06-01T00:00:00.000Z'),
};

describe('DevicesService', () => {
  let service: DevicesService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    repo = {
      ensureSeeded: vi.fn(),
      list: vi.fn(),
      findById: vi.fn(),
      update: vi.fn(),
      touchLastSeen: vi.fn(),
      remove: vi.fn(),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [DevicesService, { provide: DevicesRepository, useValue: repo }],
    }).compile();
    service = moduleRef.get(DevicesService);
  });

  const summary = { total: 1, byStatus: { online: 1, degraded: 0, offline: 0 } };

  describe('list', () => {
    it('seeds on first read and maps rows to ISO last-seen', async () => {
      repo.list.mockResolvedValue({ items: [onu], total: 1, summary });
      const { items, total } = await service.list({ limit: 200, offset: 0 });
      expect(repo.ensureSeeded).toHaveBeenCalledTimes(1);
      expect(total).toBe(1);
      expect(items[0]).toMatchObject({
        id: onu.id,
        type: 'onu',
        rxPower: -18.5,
        lastSeenAt: '2026-06-15T00:00:00.000Z',
      });
    });

    it('passes the summary rollup through unchanged (FE contract parity)', async () => {
      repo.list.mockResolvedValue({ items: [onu], total: 1, summary });
      const result = await service.list({ limit: 200, offset: 0 });
      expect(result.summary).toEqual(summary);
    });

    it('passes q filter through to the repo', async () => {
      const filter = { q: 'ONU', limit: 200, offset: 0 };
      repo.list.mockResolvedValue({ items: [onu], total: 1 });

      const result = await service.list(filter);

      expect(repo.list).toHaveBeenCalledWith(filter);
      expect(result.total).toBe(1);
    });

    it('passes status filter through to the repo', async () => {
      const filter = { status: 'online' as const, limit: 200, offset: 0 };
      repo.list.mockResolvedValue({ items: [onu], total: 1 });

      await service.list(filter);

      expect(repo.list).toHaveBeenCalledWith(filter);
    });

    it('passes q + status composed filter through to the repo', async () => {
      const filter = { q: 'Jepara', status: 'online' as const, limit: 200, offset: 0 };
      repo.list.mockResolvedValue({ items: [onu], total: 1 });

      await service.list(filter);

      expect(repo.list).toHaveBeenCalledWith(filter);
    });

    it('passes sort and order through to the repo', async () => {
      const filter = { sort: 'name', order: 'asc' as const, limit: 200, offset: 0 };
      repo.list.mockResolvedValue({ items: [onu], total: 1 });

      const result = await service.list(filter);

      expect(repo.list).toHaveBeenCalledWith(filter);
      expect(result.total).toBe(1);
    });

    it('passes sort desc through to the repo', async () => {
      const filter = { sort: 'uptimeHours', order: 'desc' as const, limit: 200, offset: 0 };
      repo.list.mockResolvedValue({ items: [], total: 0 });

      await service.list(filter);

      expect(repo.list).toHaveBeenCalledWith(filter);
    });

    it('returns empty items when repo returns empty', async () => {
      repo.list.mockResolvedValue({ items: [], total: 0 });

      const result = await service.list({ limit: 200, offset: 0 });

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('findById', () => {
    it('returns the mapped device', async () => {
      repo.findById.mockResolvedValue(onu);
      const device = await service.findById(onu.id);
      expect(device.name).toBe('ONU-0001');
    });

    it('throws 404 when missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.findById('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('reboot', () => {
    it('refreshes last-seen and returns the device', async () => {
      repo.findById.mockResolvedValue(onu);
      repo.touchLastSeen.mockResolvedValue({
        ...onu,
        lastSeenAt: new Date('2026-06-16T00:00:00.000Z'),
      });
      const device = await service.reboot(onu.id);
      expect(repo.touchLastSeen).toHaveBeenCalledWith(onu.id);
      expect(device.lastSeenAt).toBe('2026-06-16T00:00:00.000Z');
    });

    it('throws 404 for an unknown device (no touch)', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.reboot('missing')).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.touchLastSeen).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('passes only provided fields to the repo', async () => {
      repo.update.mockResolvedValue({ ...onu, name: 'ONU-RENAMED' });
      const device = await service.update(onu.id, { name: 'ONU-RENAMED' });
      expect(repo.update).toHaveBeenCalledWith(onu.id, { name: 'ONU-RENAMED' });
      expect(device.name).toBe('ONU-RENAMED');
    });
  });

  describe('remove', () => {
    it('delegates to the repo', async () => {
      await service.remove(onu.id);
      expect(repo.remove).toHaveBeenCalledWith(onu.id);
    });
  });
});
