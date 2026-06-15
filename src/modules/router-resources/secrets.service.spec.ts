import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PppSecret } from '../../infrastructure/database/schema/pppoe.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { RoutersRepository } from '../routers/routers.repository';
import { ProfilesRepository } from './profiles.repository';
import { SecretsRepository } from './secrets.repository';
import { SecretsService } from './secrets.service';

const ROUTER_ID = '00000000-0000-0000-0000-00000000a101';
const PROFILE_ID = '00000000-0000-0000-0000-00000000b101';
const secret: PppSecret = {
  id: '00000000-0000-0000-0000-00000000c101',
  routerId: ROUTER_ID,
  username: 'cust9001',
  profileId: PROFILE_ID,
  profileName: 'Home20',
  customerId: null,
  customerName: null,
  disabled: false,
  comment: null,
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

describe('SecretsService', () => {
  let service: SecretsService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let profiles: { findById: ReturnType<typeof vi.fn> };
  let routers: { findById: ReturnType<typeof vi.fn>; adjustSecretCount: ReturnType<typeof vi.fn> };
  let customers: { findIdByFullName: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      listByRouter: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    };
    profiles = { findById: vi.fn() };
    routers = { findById: vi.fn(), adjustSecretCount: vi.fn() };
    customers = { findIdByFullName: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SecretsService,
        { provide: SecretsRepository, useValue: repo },
        { provide: ProfilesRepository, useValue: profiles },
        { provide: RoutersRepository, useValue: routers },
        { provide: CustomersRepository, useValue: customers },
      ],
    }).compile();
    service = moduleRef.get(SecretsService);
  });

  describe('create', () => {
    it('denormalises profile name, resolves the customer, and bumps secretCount', async () => {
      routers.findById.mockResolvedValue({ id: ROUTER_ID });
      profiles.findById.mockResolvedValue({ id: PROFILE_ID, routerId: ROUTER_ID, name: 'Home20' });
      customers.findIdByFullName.mockResolvedValue('cust-1');
      repo.create.mockResolvedValue({ ...secret, customerId: 'cust-1', customerName: 'Budi' });

      await service.create(ROUTER_ID, {
        username: 'cust9001',
        password: 'pw',
        profileId: PROFILE_ID,
        customerName: 'Budi',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          profileName: 'Home20',
          customerId: 'cust-1',
          customerName: 'Budi',
        }),
      );
      expect(routers.adjustSecretCount).toHaveBeenCalledWith(ROUTER_ID, 1);
    });

    it('rejects a profile that is not on this router', async () => {
      routers.findById.mockResolvedValue({ id: ROUTER_ID });
      profiles.findById.mockResolvedValue({ id: PROFILE_ID, routerId: 'other', name: 'X' });
      await expect(
        service.create(ROUTER_ID, { username: 'u', password: 'p', profileId: PROFILE_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.create).not.toHaveBeenCalled();
      expect(routers.adjustSecretCount).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('refreshes profileName on profile change and clears the customer on null', async () => {
      repo.findById.mockResolvedValue(secret);
      profiles.findById.mockResolvedValue({ id: 'p2', routerId: ROUTER_ID, name: 'Pro100' });
      repo.update.mockResolvedValue(secret);
      await service.update(ROUTER_ID, secret.id, { profileId: 'p2', customerName: null });
      expect(repo.update).toHaveBeenCalledWith(secret.id, {
        profileId: 'p2',
        profileName: 'Pro100',
        customerName: null,
        customerId: null,
      });
    });

    it('does not change secretCount', async () => {
      repo.findById.mockResolvedValue(secret);
      repo.update.mockResolvedValue({ ...secret, disabled: true });
      await service.update(ROUTER_ID, secret.id, { disabled: true });
      expect(routers.adjustSecretCount).not.toHaveBeenCalled();
    });

    it('404s for a secret on another router', async () => {
      repo.findById.mockResolvedValue({ ...secret, routerId: 'other' });
      await expect(service.update(ROUTER_ID, secret.id, { disabled: true })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  it('remove deletes and decrements secretCount', async () => {
    repo.findById.mockResolvedValue(secret);
    await service.remove(ROUTER_ID, secret.id);
    expect(repo.remove).toHaveBeenCalledWith(secret.id);
    expect(routers.adjustSecretCount).toHaveBeenCalledWith(ROUTER_ID, -1);
  });
});
