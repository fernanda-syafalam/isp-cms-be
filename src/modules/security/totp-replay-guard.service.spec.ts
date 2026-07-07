import { beforeEach, describe, expect, it } from 'vitest';
import type { RedisService } from '../../infrastructure/redis/redis.service';
import { createFakeRedisClient } from '../../test-utils/fake-redis-client';
import { TotpReplayGuardService } from './totp-replay-guard.service';

describe('TotpReplayGuardService', () => {
  const userId = '00000000-0000-0000-0000-0000000000a1';
  let client: ReturnType<typeof createFakeRedisClient>;
  let service: TotpReplayGuardService;

  beforeEach(() => {
    client = createFakeRedisClient();
    service = new TotpReplayGuardService({ client } as unknown as RedisService);
  });

  it('accepts the first step ever seen for a user', async () => {
    await expect(service.acceptStep(userId, 100)).resolves.toBe(true);
  });

  it('rejects an exact replay of an already-accepted step', async () => {
    await expect(service.acceptStep(userId, 100)).resolves.toBe(true);
    await expect(service.acceptStep(userId, 100)).resolves.toBe(false);
  });

  it('rejects a step older than the last accepted one', async () => {
    await expect(service.acceptStep(userId, 100)).resolves.toBe(true);
    await expect(service.acceptStep(userId, 99)).resolves.toBe(false);
  });

  it('accepts a strictly later step', async () => {
    await expect(service.acceptStep(userId, 100)).resolves.toBe(true);
    await expect(service.acceptStep(userId, 101)).resolves.toBe(true);
  });

  it('tracks acceptance independently per user', async () => {
    const userA = userId;
    const userB = '00000000-0000-0000-0000-0000000000b9';

    await expect(service.acceptStep(userA, 100)).resolves.toBe(true);
    // userB never saw step 100 before — not a replay for them.
    await expect(service.acceptStep(userB, 100)).resolves.toBe(true);
    // ...but a repeat for userA still is.
    await expect(service.acceptStep(userA, 100)).resolves.toBe(false);
  });

  // M1: the compare-and-set is a single atomic Redis EVAL (see
  // `ACCEPT_STEP_SCRIPT`), not a separate GET-then-SET — so even two
  // "concurrent" callers racing for the same step resolve to exactly one
  // acceptance, never both.
  it('accepts at most one of two concurrent attempts at the same step', async () => {
    const [a, b] = await Promise.all([
      service.acceptStep(userId, 42),
      service.acceptStep(userId, 42),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('issues the accept-step script as a single-key EVAL scoped to the user', async () => {
    await service.acceptStep(userId, 7);
    expect(client.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringContaining(userId),
      '7',
      String(TotpReplayGuardService.TTL_SECONDS),
    );
  });
});
