import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../infrastructure/database/schema/settings.schema';
import { SettingsRepository } from './settings.repository';
import { SettingsService } from './settings.service';

const row: AppSettings = {
  id: '00000000-0000-0000-0000-00000000a201',
  singleton: true,
  companyName: 'Jepara Net',
  companyAddress: 'Jl. Pemuda No. 12',
  companyPhone: '0291-591234',
  companyEmail: 'billing@jeparanet.id',
  billingLateFeeIdr: 25_000,
  billingDueDays: 10,
  billingIsolirGraceDays: 3,
  taxPkp: true,
  taxNpwp: '01.234.567.8-901.000',
  taxPpnRate: 0.11,
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

describe('SettingsService', () => {
  let service: SettingsService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    repo = { getOrCreate: vi.fn(), update: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [SettingsService, { provide: SettingsRepository, useValue: repo }],
    }).compile();
    service = moduleRef.get(SettingsService);
  });

  it('get seeds + returns the nested settings shape', async () => {
    repo.getOrCreate.mockResolvedValue(row);
    const result = await service.get();
    expect(repo.getOrCreate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      company: {
        name: 'Jepara Net',
        address: 'Jl. Pemuda No. 12',
        phone: '0291-591234',
        email: 'billing@jeparanet.id',
      },
      billing: { lateFeeIdr: 25_000, dueDays: 10, isolirGraceDays: 3 },
      tax: { pkp: true, npwp: '01.234.567.8-901.000', ppnRate: 0.11 },
    });
  });

  it('getPublic returns only the company + tax sections (no billing)', async () => {
    repo.getOrCreate.mockResolvedValue(row);
    const result = await service.getPublic();
    expect(result).toEqual({
      company: {
        name: 'Jepara Net',
        address: 'Jl. Pemuda No. 12',
        phone: '0291-591234',
        email: 'billing@jeparanet.id',
      },
      tax: { pkp: true, npwp: '01.234.567.8-901.000', ppnRate: 0.11 },
    });
    expect(result).not.toHaveProperty('billing');
  });

  it('update flattens only the provided sections into the patch', async () => {
    repo.getOrCreate.mockResolvedValue(row);
    repo.update.mockResolvedValue({ ...row, billingLateFeeIdr: 50_000, billingDueDays: 15 });

    await service.update({ billing: { lateFeeIdr: 50_000, dueDays: 15, isolirGraceDays: 5 } });

    expect(repo.update).toHaveBeenCalledWith({
      billingLateFeeIdr: 50_000,
      billingDueDays: 15,
      billingIsolirGraceDays: 5,
    });
  });

  it('update maps company + tax sections to flat columns', async () => {
    repo.getOrCreate.mockResolvedValue(row);
    repo.update.mockResolvedValue(row);
    await service.update({
      company: { name: 'PT Ashnet', address: 'Jl. X', phone: '021', email: 'a@b.id' },
      tax: { pkp: false, npwp: '99', ppnRate: 0 },
    });
    expect(repo.update).toHaveBeenCalledWith({
      companyName: 'PT Ashnet',
      companyAddress: 'Jl. X',
      companyPhone: '021',
      companyEmail: 'a@b.id',
      taxPkp: false,
      taxNpwp: '99',
      taxPpnRate: 0,
    });
  });
});
