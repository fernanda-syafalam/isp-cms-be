import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contract } from '../../infrastructure/database/schema/contracts.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { ContractsRepository } from './contracts.repository';
import { ContractsService } from './contracts.service';

const CUSTOMER_ID = '00000000-0000-0000-0000-0000000000c1';

const contract: Contract = {
  id: '00000000-0000-0000-0000-00000000e001',
  number: 'PKS-2026-0001',
  customerId: CUSTOMER_ID,
  customerName: 'Budi Santoso',
  planName: 'Home 20',
  status: 'draft',
  meterai: false,
  signedAt: null,
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

describe('ContractsService', () => {
  let service: ContractsService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let customers: { findById: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      findByCustomerId: vi.fn(),
      create: vi.fn(),
      markSent: vi.fn(),
      markSigned: vi.fn(),
    };
    customers = { findById: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ContractsService,
        { provide: ContractsRepository, useValue: repo },
        { provide: CustomersRepository, useValue: customers },
      ],
    }).compile();
    service = moduleRef.get(ContractsService);
  });

  it('getForCustomer wraps null when no contract exists', async () => {
    repo.findByCustomerId.mockResolvedValue(null);
    await expect(service.getForCustomer(CUSTOMER_ID)).resolves.toEqual({ contract: null });
  });

  describe('create', () => {
    it('snapshots customer name + plan onto a new draft', async () => {
      repo.findByCustomerId.mockResolvedValue(null);
      customers.findById.mockResolvedValue({
        id: CUSTOMER_ID,
        fullName: 'Budi Santoso',
        planName: 'Home 20',
      });
      repo.create.mockResolvedValue(contract);

      const result = await service.create(CUSTOMER_ID);
      expect(repo.create).toHaveBeenCalledWith({
        customerId: CUSTOMER_ID,
        customerName: 'Budi Santoso',
        planName: 'Home 20',
      });
      expect(result.status).toBe('draft');
    });

    it('is idempotent — returns the existing contract', async () => {
      repo.findByCustomerId.mockResolvedValue(contract);
      const result = await service.create(CUSTOMER_ID);
      expect(customers.findById).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
      expect(result.number).toBe('PKS-2026-0001');
    });

    it('throws 404 when the customer does not exist', async () => {
      repo.findByCustomerId.mockResolvedValue(null);
      customers.findById.mockResolvedValue(null);
      await expect(service.create(CUSTOMER_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('send', () => {
    it('marks a draft as sent', async () => {
      repo.findByCustomerId.mockResolvedValue(contract);
      repo.markSent.mockResolvedValue({ ...contract, status: 'sent' });
      const result = await service.send(CUSTOMER_ID);
      expect(result.status).toBe('sent');
    });

    it('rejects sending a signed contract', async () => {
      repo.findByCustomerId.mockResolvedValue({ ...contract, status: 'signed' });
      await expect(service.send(CUSTOMER_ID)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws 404 when no contract exists', async () => {
      repo.findByCustomerId.mockResolvedValue(null);
      await expect(service.send(CUSTOMER_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('sign', () => {
    it('signs and applies e-meterai', async () => {
      repo.findByCustomerId.mockResolvedValue({ ...contract, status: 'sent' });
      repo.markSigned.mockResolvedValue({
        ...contract,
        status: 'signed',
        meterai: true,
        signedAt: new Date('2026-06-15T10:00:00.000Z'),
      });
      const result = await service.sign(CUSTOMER_ID);
      expect(result.status).toBe('signed');
      expect(result.meterai).toBe(true);
      expect(result.signedAt).toBe('2026-06-15T10:00:00.000Z');
    });

    it('is idempotent for an already-signed contract', async () => {
      repo.findByCustomerId.mockResolvedValue({ ...contract, status: 'signed', meterai: true });
      await service.sign(CUSTOMER_ID);
      expect(repo.markSigned).not.toHaveBeenCalled();
    });
  });
});
