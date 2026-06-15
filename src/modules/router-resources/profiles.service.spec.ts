import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PppProfile } from '../../infrastructure/database/schema/pppoe.schema';
import { RoutersRepository } from '../routers/routers.repository';
import { ProfilesRepository } from './profiles.repository';
import { ProfilesService } from './profiles.service';

const ROUTER_ID = '00000000-0000-0000-0000-00000000a101';
const profile: PppProfile = {
  id: '00000000-0000-0000-0000-00000000b101',
  routerId: ROUTER_ID,
  name: 'Home20',
  rateLimit: '20M/20M',
  isIsolir: false,
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

describe('ProfilesService', () => {
  let service: ProfilesService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let routers: { findById: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      listByRouter: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    };
    routers = { findById: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ProfilesService,
        { provide: ProfilesRepository, useValue: repo },
        { provide: RoutersRepository, useValue: routers },
      ],
    }).compile();
    service = moduleRef.get(ProfilesService);
  });

  it('list maps profiles when the router exists', async () => {
    routers.findById.mockResolvedValue({ id: ROUTER_ID });
    repo.listByRouter.mockResolvedValue({ items: [profile], total: 1 });
    const result = await service.list(ROUTER_ID);
    expect(result.items[0]?.isIsolir).toBe(false);
  });

  it('list 404s on an unknown router', async () => {
    routers.findById.mockResolvedValue(null);
    await expect(service.list(ROUTER_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('create attaches the router id', async () => {
    routers.findById.mockResolvedValue({ id: ROUTER_ID });
    repo.create.mockResolvedValue(profile);
    await service.create(ROUTER_ID, { name: 'Home20', rateLimit: '20M/20M' });
    expect(repo.create).toHaveBeenCalledWith({
      routerId: ROUTER_ID,
      name: 'Home20',
      rateLimit: '20M/20M',
    });
  });

  it('update/remove 404 when the profile belongs to another router', async () => {
    repo.findById.mockResolvedValue({ ...profile, routerId: 'other' });
    await expect(service.update(ROUTER_ID, profile.id, { name: 'X' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.remove(ROUTER_ID, profile.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.remove).not.toHaveBeenCalled();
  });

  it('update applies the patch for an owned profile', async () => {
    repo.findById.mockResolvedValue(profile);
    repo.update.mockResolvedValue({ ...profile, rateLimit: '50M/50M' });
    const result = await service.update(ROUTER_ID, profile.id, { rateLimit: '50M/50M' });
    expect(repo.update).toHaveBeenCalledWith(profile.id, { rateLimit: '50M/50M' });
    expect(result.rateLimit).toBe('50M/50M');
  });
});
