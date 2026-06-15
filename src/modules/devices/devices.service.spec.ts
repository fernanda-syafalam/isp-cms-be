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

  describe('list', () => {
    it('seeds on first read and maps rows to ISO last-seen', async () => {
      repo.list.mockResolvedValue({ items: [onu], total: 1 });
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
