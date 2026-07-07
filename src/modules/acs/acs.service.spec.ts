import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcsDevice } from '../../infrastructure/database/schema/acs.schema';
import { AcsRepository } from './acs.repository';
import { AcsService } from './acs.service';

const device: AcsDevice = {
  id: '00000000-0000-0000-0000-00000000a501',
  serial: 'ZTEG10000001',
  customerName: 'Budi Santoso',
  model: 'ZTE F670L',
  firmware: 'v2.3.0',
  ssid: null,
  rxPowerDbm: -21.5,
  status: 'online',
  lastInform: new Date('2026-06-15T00:00:00.000Z'),
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

describe('AcsService', () => {
  let service: AcsService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    repo = {
      ensureSeeded: vi.fn(),
      list: vi.fn(),
      countByIds: vi.fn(),
      updateFirmware: vi.fn(),
      findByCustomerName: vi.fn(),
      setWifi: vi.fn(),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [AcsService, { provide: AcsRepository, useValue: repo }],
    }).compile();
    service = moduleRef.get(AcsService);
  });

  const summary = { total: 2, byStatus: { online: 1, offline: 1 } };

  it('list seeds then maps devices (rxPower nullable)', async () => {
    repo.list.mockResolvedValue({
      items: [device, { ...device, id: 'x', rxPowerDbm: null, status: 'offline' }],
      total: 2,
      summary,
    });
    const result = await service.list({ limit: 100, offset: 0 });
    expect(repo.ensureSeeded).toHaveBeenCalledTimes(1);
    expect(result.items[0]?.rxPowerDbm).toBeCloseTo(-21.5);
    expect(result.items[1]?.rxPowerDbm).toBeNull();
    expect(result.items[0]?.lastInform).toBe('2026-06-15T00:00:00.000Z');
  });

  it('list passes the summary rollup through unchanged (FE contract parity)', async () => {
    repo.list.mockResolvedValue({ items: [device], total: 1, summary });
    const result = await service.list({ limit: 100, offset: 0 });
    expect(result.summary).toEqual(summary);
  });

  it('forwards q to the repository', async () => {
    repo.list.mockResolvedValue({ items: [device], total: 1 });
    await service.list({ q: 'ZTEG', limit: 100, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith({ q: 'ZTEG', limit: 100, offset: 0 });
  });

  it('forwards sort and order to the repository', async () => {
    repo.list.mockResolvedValue({ items: [device], total: 1 });
    await service.list({ sort: 'serial', order: 'desc', limit: 50, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith({ sort: 'serial', order: 'desc', limit: 50, offset: 0 });
  });

  it('returns filtered total from the repository unchanged', async () => {
    repo.list.mockResolvedValue({ items: [device], total: 42 });
    const result = await service.list({ q: 'Budi', limit: 10, offset: 0 });
    expect(result.total).toBe(42);
    expect(result.items).toHaveLength(1);
  });

  describe('bulk', () => {
    it('firmware pushes the version and returns rows updated', async () => {
      repo.updateFirmware.mockResolvedValue(2);
      const result = await service.bulk({
        action: 'firmware',
        deviceIds: ['a', 'b'],
        firmwareVersion: 'v2.4.1',
      });
      expect(repo.updateFirmware).toHaveBeenCalledWith(['a', 'b'], 'v2.4.1');
      expect(result.affected).toBe(2);
    });

    it('firmware without a version is rejected', async () => {
      await expect(service.bulk({ action: 'firmware', deviceIds: ['a'] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repo.updateFirmware).not.toHaveBeenCalled();
    });

    it('reboot counts existing devices without persisting', async () => {
      repo.countByIds.mockResolvedValue(3);
      const result = await service.bulk({ action: 'reboot', deviceIds: ['a', 'b', 'c'] });
      expect(repo.countByIds).toHaveBeenCalledWith(['a', 'b', 'c']);
      expect(repo.updateFirmware).not.toHaveBeenCalled();
      expect(result.affected).toBe(3);
    });

    it('wifi requires ssid + password', async () => {
      await expect(
        service.bulk({ action: 'wifi', deviceIds: ['a'], ssid: 'Net' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('wifi with credentials counts existing devices', async () => {
      repo.countByIds.mockResolvedValue(1);
      const result = await service.bulk({
        action: 'wifi',
        deviceIds: ['a'],
        ssid: 'Net',
        password: 'supersecret',
      });
      expect(result.affected).toBe(1);
    });
  });

  // --- portal WiFi self-care seam (P3.C.4) ------------------------------------

  describe('wifiForCustomer', () => {
    it('seeds then resolves the caller device by exact customerName match', async () => {
      repo.findByCustomerName.mockResolvedValue(device);
      const result = await service.wifiForCustomer('Budi Santoso');
      expect(repo.ensureSeeded).toHaveBeenCalledTimes(1);
      expect(repo.findByCustomerName).toHaveBeenCalledWith('Budi Santoso');
      expect(result).toEqual({ serial: 'ZTEG10000001', model: 'ZTE F670L', ssid: null });
    });

    it('404s when no device is denormalized to that customer name', async () => {
      repo.findByCustomerName.mockResolvedValue(null);
      await expect(service.wifiForCustomer('Nobody')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('setWifiForCustomer', () => {
    it('validates ssid/password, persists only the ssid, and acks with the new value', async () => {
      repo.findByCustomerName.mockResolvedValue(device);
      repo.setWifi.mockResolvedValue({ ...device, ssid: 'RumahBudi_5G' });

      const result = await service.setWifiForCustomer(
        'Budi Santoso',
        'RumahBudi_5G',
        'supersecret',
      );

      expect(repo.setWifi).toHaveBeenCalledWith(device.id, 'RumahBudi_5G');
      expect(result).toEqual({ ok: true, ssid: 'RumahBudi_5G' });
    });

    it('rejects an ssid over 32 chars before touching the repository', async () => {
      await expect(
        service.setWifiForCustomer('Budi Santoso', 'x'.repeat(33), 'supersecret'),
      ).rejects.toThrow();
      expect(repo.findByCustomerName).not.toHaveBeenCalled();
    });

    it('rejects a password shorter than 8 chars before touching the repository', async () => {
      await expect(service.setWifiForCustomer('Budi Santoso', 'Net', 'short')).rejects.toThrow();
      expect(repo.findByCustomerName).not.toHaveBeenCalled();
    });

    it('404s when no device is denormalized to that customer name', async () => {
      repo.findByCustomerName.mockResolvedValue(null);
      await expect(
        service.setWifiForCustomer('Nobody', 'Net12345', 'supersecret'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
