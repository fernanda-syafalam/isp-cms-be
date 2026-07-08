import { Logger, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Router } from '../../infrastructure/database/schema/routers.schema';
import { RouterCredentialCipherService } from './router-credential-cipher.service';
import { RoutersRepository } from './routers.repository';
import { RoutersService } from './routers.service';

const router: Router = {
  id: '00000000-0000-0000-0000-00000000a101',
  name: 'Core-1',
  address: '10.0.0.1',
  apiPort: 8728,
  username: 'apiuser',
  apiUsername: null,
  apiPasswordEncrypted: null,
  model: 'RB5009',
  version: '7.15.3',
  status: 'online',
  secretCount: 0,
  lastSyncAt: new Date('2026-06-15T00:00:00.000Z'),
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

const connectInput = {
  name: 'Core-1',
  host: '10.0.0.1',
  apiPort: 8728,
  username: 'apiuser',
  password: 'secret',
  useTls: false,
};

describe('RoutersService', () => {
  let service: RoutersService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let cipher: { encrypt: ReturnType<typeof vi.fn>; decrypt: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      list: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      markSynced: vi.fn(),
    };
    cipher = {
      encrypt: vi.fn((plaintext: string) => `enc(${plaintext})`),
      decrypt: vi.fn(),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        RoutersService,
        { provide: RoutersRepository, useValue: repo },
        { provide: RouterCredentialCipherService, useValue: cipher },
      ],
    }).compile();
    service = moduleRef.get(RoutersService);
  });

  it('testConnection returns a probe result without persisting', () => {
    const result = service.testConnection(connectInput);
    expect(result.ok).toBe(true);
    expect(result.identity).toBe('MikroTik-10.0.0.1');
    expect(result.model).toBeTypeOf('string');
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('connect maps host to address and synthesises model/version deterministically', async () => {
    repo.create.mockResolvedValue(router);
    await service.connect(connectInput);
    const arg = repo.create.mock.calls[0]?.[0];
    expect(arg.address).toBe('10.0.0.1');
    // deterministic: connect and a probe agree on model/version for a host
    const probe = service.testConnection(connectInput);
    expect(arg.model).toBe(probe.model);
    expect(arg.version).toBe(probe.version);
  });

  it('connect (SEC-M1) persists the password as an encrypted per-router credential, never plaintext', async () => {
    repo.create.mockResolvedValue(router);
    await service.connect(connectInput);
    expect(cipher.encrypt).toHaveBeenCalledWith('secret');
    const arg = repo.create.mock.calls[0]?.[0];
    expect(arg.apiPasswordEncrypted).toBe('enc(secret)');
    expect(arg.apiPasswordEncrypted).not.toBe('secret');
  });

  it('connect defaults apiUsername to null when not provided', async () => {
    repo.create.mockResolvedValue(router);
    await service.connect(connectInput);
    const arg = repo.create.mock.calls[0]?.[0];
    expect(arg.apiUsername).toBeNull();
  });

  describe('update (SEC-M1)', () => {
    it('patches only the provided fields', async () => {
      repo.findById.mockResolvedValue(router);
      repo.update.mockResolvedValue({ ...router, name: 'Core-1-Renamed' });

      await service.update(router.id, { name: 'Core-1-Renamed' });

      expect(repo.update).toHaveBeenCalledWith(router.id, { name: 'Core-1-Renamed' });
    });

    it('encrypts a new password when provided, never persisting it plaintext', async () => {
      repo.findById.mockResolvedValue(router);
      repo.update.mockResolvedValue(router);

      await service.update(router.id, { password: 'new-secret' });

      expect(cipher.encrypt).toHaveBeenCalledWith('new-secret');
      const patch = repo.update.mock.calls[0]?.[1];
      expect(patch.apiPasswordEncrypted).toBe('enc(new-secret)');
    });

    it('404s on an unknown router', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.update('missing', { name: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('logs a security warning when host actually changes (host-change audit)', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      repo.findById.mockResolvedValue(router);
      repo.update.mockResolvedValue({ ...router, address: '203.0.113.9' });

      await service.update(router.id, { host: '203.0.113.9' }, 'admin@example.com');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          routerId: router.id,
          oldHost: '10.0.0.1',
          newHost: '203.0.113.9',
          actor: 'admin@example.com',
        }),
        expect.stringContaining('host changed'),
      );
      warnSpy.mockRestore();
    });

    it('does NOT log a host-change warning when host is unchanged or omitted', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      repo.findById.mockResolvedValue(router);
      repo.update.mockResolvedValue(router);

      await service.update(router.id, { host: router.address });
      await service.update(router.id, { name: 'still no host change' });

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  it('sync marks the router synced', async () => {
    repo.markSynced.mockResolvedValue({ ...router, status: 'online' });
    const result = await service.sync(router.id);
    expect(repo.markSynced).toHaveBeenCalledWith(router.id);
    expect(result.status).toBe('online');
  });

  it('reboot / test 404 on an unknown router', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(service.reboot('missing')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.test('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  const summary = { total: 1, byStatus: { online: 1, offline: 0 } };

  it('list maps routers and exposes secretCount + lastSyncAt', async () => {
    repo.list.mockResolvedValue({ items: [router], total: 1, summary });
    const result = await service.list({ limit: 50, offset: 0 });
    expect(result.items[0]?.secretCount).toBe(0);
    expect(result.items[0]?.lastSyncAt).toBe('2026-06-15T00:00:00.000Z');
  });

  it('passes the summary rollup through unchanged (FE contract parity)', async () => {
    repo.list.mockResolvedValue({ items: [router], total: 1, summary });
    const result = await service.list({ limit: 50, offset: 0 });
    expect(result.summary).toEqual(summary);
  });

  it('forwards q to the repository', async () => {
    repo.list.mockResolvedValue({ items: [router], total: 1 });
    await service.list({ q: 'Core', limit: 50, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith({ q: 'Core', limit: 50, offset: 0 });
  });

  it('forwards sort and order to the repository', async () => {
    repo.list.mockResolvedValue({ items: [router], total: 1 });
    await service.list({ sort: 'name', order: 'asc', limit: 50, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith({ sort: 'name', order: 'asc', limit: 50, offset: 0 });
  });

  it('returns filtered total from the repository unchanged', async () => {
    repo.list.mockResolvedValue({ items: [router], total: 42 });
    const result = await service.list({ q: 'Core', limit: 10, offset: 0 });
    expect(result.total).toBe(42);
    expect(result.items).toHaveLength(1);
  });
});
