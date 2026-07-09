import { Test, type TestingModule } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { DrizzleService } from '../src/infrastructure/database/drizzle.service';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { EmailProcessor } from '../src/modules/email/email.processor';
import { NotificationsProcessor } from '../src/modules/notifications/notifications.processor';
import { SchedulerProcessor } from '../src/modules/scheduler/scheduler.processor';
import { WorkerModule } from '../src/worker.module';

/**
 * Locks the R10-OPS-1 invariant: BullMQ processors (WorkerHosts) must be
 * instantiated ONLY in the worker process, never in the API. A regression
 * that reintroduces a processor into AppModule — e.g. importing
 * NotificationsWorkerModule/EmailWorkerModule/SchedulerModule from
 * AppModule, or re-adding *Processor to a producer module's `providers` —
 * must fail this test.
 *
 * Same DrizzleService/RedisService stub overrides as the other e2e specs
 * (see test/health.e2e-spec.ts) so this boots without real Postgres/Redis.
 * We only need `.compile()` (which eagerly builds the full DI graph, same
 * as `Test.createTestingModule` does for every unit test's `.get()` to
 * work) — no `.init()`/HTTP listener, since we are only asserting provider
 * *presence*, not runtime behavior.
 */
function drizzleStub() {
  return {
    ping: async () => true,
    onModuleInit: () => Promise.resolve(),
    onModuleDestroy: () => Promise.resolve(),
  };
}

function redisStub() {
  return {
    client: { call: async () => null, get: async () => null, set: async () => 'OK' },
    ping: async () => true,
    onModuleInit: () => Promise.resolve(),
    onModuleDestroy: () => Promise.resolve(),
  };
}

describe('BullMQ processor isolation (R10-OPS-1)', () => {
  it('AppModule (API process) registers ZERO BullMQ processors', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DrizzleService)
      .useValue(drizzleStub())
      .overrideProvider(RedisService)
      .useValue(redisStub())
      .compile();

    expect(() => moduleRef.get(EmailProcessor, { strict: false })).toThrow();
    expect(() => moduleRef.get(NotificationsProcessor, { strict: false })).toThrow();
    expect(() => moduleRef.get(SchedulerProcessor, { strict: false })).toThrow();

    await moduleRef.close();
  });

  it('WorkerModule registers ALL THREE BullMQ processors', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [WorkerModule],
    })
      .overrideProvider(DrizzleService)
      .useValue(drizzleStub())
      .overrideProvider(RedisService)
      .useValue(redisStub())
      .compile();

    expect(moduleRef.get(EmailProcessor, { strict: false })).toBeInstanceOf(EmailProcessor);
    expect(moduleRef.get(NotificationsProcessor, { strict: false })).toBeInstanceOf(
      NotificationsProcessor,
    );
    expect(moduleRef.get(SchedulerProcessor, { strict: false })).toBeInstanceOf(SchedulerProcessor);

    await moduleRef.close();
  });
});
