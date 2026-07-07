import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedisService } from '../../infrastructure/redis/redis.service';
import { TotpReplayGuardService } from './totp-replay-guard.service';

describe('TotpReplayGuardService', () => {
  const userId = '00000000-0000-0000-0000-0000000000a1';
  let client: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
  };
  let service: TotpReplayGuardService;

  beforeEach(() => {
    client = {
      get: vi.fn(),
      set: vi.fn(),
      expire: vi.fn(),
    };
    service = new TotpReplayGuardService({ client } as unknown as RedisService);
  });

  it('has no last-accepted step when nothing was ever recorded', async () => {
    client.get.mockResolvedValue(null);
    await expect(service.getLastAcceptedStep(userId)).resolves.toBeNull();
  });

  it('returns the recorded step as a number', async () => {
    client.get.mockResolvedValue('12345');
    await expect(service.getLastAcceptedStep(userId)).resolves.toBe(12345);
  });

  it('scopes the key to the user', async () => {
    client.get.mockResolvedValue(null);
    await service.getLastAcceptedStep(userId);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining(userId));
  });

  it('records a step and sets the self-expiry TTL', async () => {
    await service.recordAcceptedStep(userId, 999);
    expect(client.set).toHaveBeenCalledWith(expect.stringContaining(userId), '999');
    expect(client.expire).toHaveBeenCalledWith(
      expect.stringContaining(userId),
      TotpReplayGuardService.TTL_SECONDS,
    );
  });
});
