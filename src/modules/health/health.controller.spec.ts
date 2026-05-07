import { ServiceUnavailableException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;
  let drizzlePing: ReturnType<typeof vi.fn>;
  let redisPing: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    drizzlePing = vi.fn();
    redisPing = vi.fn();
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: DrizzleService, useValue: { ping: drizzlePing } },
        { provide: RedisService, useValue: { ping: redisPing } },
      ],
    }).compile();

    controller = moduleRef.get<HealthController>(HealthController);
  });

  it('liveness returns status ok without touching dependencies', () => {
    expect(controller.liveness()).toEqual({ status: 'ok' });
    expect(drizzlePing).not.toHaveBeenCalled();
    expect(redisPing).not.toHaveBeenCalled();
  });

  it('readiness returns ok when both deps respond', async () => {
    drizzlePing.mockResolvedValue(true);
    redisPing.mockResolvedValue(true);
    await expect(controller.readiness()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'ok', redis: 'ok' },
    });
  });

  it('readiness throws 503 when database ping fails', async () => {
    drizzlePing.mockResolvedValue(false);
    redisPing.mockResolvedValue(true);
    await expect(controller.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('readiness throws 503 when redis ping fails', async () => {
    drizzlePing.mockResolvedValue(true);
    redisPing.mockResolvedValue(false);
    await expect(controller.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
