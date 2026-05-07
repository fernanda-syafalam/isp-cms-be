import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    controller = moduleRef.get<HealthController>(HealthController);
  });

  it('liveness returns status ok', () => {
    expect(controller.liveness()).toEqual({ status: 'ok' });
  });

  it('readiness returns status ok', () => {
    expect(controller.readiness()).toEqual({ status: 'ok' });
  });
});
