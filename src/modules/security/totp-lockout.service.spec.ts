import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedisService } from '../../infrastructure/redis/redis.service';
import { TotpLockoutService } from './totp-lockout.service';

describe('TotpLockoutService', () => {
  const userId = '00000000-0000-0000-0000-0000000000a1';
  let client: {
    get: ReturnType<typeof vi.fn>;
    incr: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  let service: TotpLockoutService;

  beforeEach(() => {
    client = {
      get: vi.fn(),
      incr: vi.fn(),
      expire: vi.fn(),
      del: vi.fn(),
    };
    service = new TotpLockoutService({ client } as unknown as RedisService);
  });

  it('is not locked when there is no counter yet', async () => {
    client.get.mockResolvedValue(null);
    await expect(service.isLocked(userId)).resolves.toBe(false);
  });

  it('is not locked below the threshold', async () => {
    client.get.mockResolvedValue(String(TotpLockoutService.MAX_ATTEMPTS - 1));
    await expect(service.isLocked(userId)).resolves.toBe(false);
  });

  it('is locked at and above the threshold', async () => {
    client.get.mockResolvedValue(String(TotpLockoutService.MAX_ATTEMPTS));
    await expect(service.isLocked(userId)).resolves.toBe(true);

    client.get.mockResolvedValue(String(TotpLockoutService.MAX_ATTEMPTS + 3));
    await expect(service.isLocked(userId)).resolves.toBe(true);
  });

  it('scopes the counter key to the user', async () => {
    client.get.mockResolvedValue(null);
    await service.isLocked(userId);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining(userId));
  });

  it('sets the lockout TTL only on the first failure of a run', async () => {
    client.incr.mockResolvedValueOnce(1);
    await service.recordFailure(userId);
    expect(client.expire).toHaveBeenCalledWith(
      expect.stringContaining(userId),
      TotpLockoutService.LOCKOUT_TTL_SECONDS,
    );

    client.expire.mockClear();
    client.incr.mockResolvedValueOnce(2);
    await service.recordFailure(userId);
    expect(client.expire).not.toHaveBeenCalled();
  });

  it('clears the counter key on success', async () => {
    await service.recordSuccess(userId);
    expect(client.del).toHaveBeenCalledWith(expect.stringContaining(userId));
  });
});
