import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoutersRepository } from '../routers/routers.repository';
import { SecretsRepository } from './secrets.repository';
import { SessionsService } from './sessions.service';

const ROUTER_ID = '00000000-0000-0000-0000-00000000a101';

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
      items: [
        { id: '00000000-0000-0000-0000-00000000c101', username: 'cust1', disabled: false },
        { id: '00000000-0000-0000-0000-00000000c102', username: 'cust2', disabled: true },
      ],
      total: 2,
    });
    const result = await service.list(ROUTER_ID);
    expect(result.total).toBe(1);
    expect(result.items[0]?.username).toBe('cust1');
    expect(result.items[0]?.address).toMatch(/^100\.64\.0\.\d+$/);
    expect(result.items[0]?.callerId).toMatch(/^AA:BB:/);
  });

  it('list / disconnect 404 on unknown router', async () => {
    routers.findById.mockResolvedValue(null);
    await expect(service.list(ROUTER_ID)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.disconnect(ROUTER_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});
