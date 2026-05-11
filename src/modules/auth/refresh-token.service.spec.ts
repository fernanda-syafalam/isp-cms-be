import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { RefreshTokenService } from './refresh-token.service';

/**
 * An in-memory ioredis stand-in. Implements only the operations
 * RefreshTokenService relies on (set with EX, getdel, del). Faster
 * and more deterministic than spinning a real Redis for these unit
 * tests; rotation behaviour against a real Redis stays covered by
 * future integration-level checks.
 */
function makeFakeRedisClient() {
  const store = new Map<string, string>();
  return {
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK' as const;
    }),
    getdel: vi.fn(async (key: string) => {
      const value = store.get(key);
      if (value === undefined) return null;
      store.delete(key);
      return value;
    }),
    del: vi.fn(async (key: string) => {
      const had = store.delete(key);
      return had ? 1 : 0;
    }),
    _store: store,
  };
}

describe('RefreshTokenService', () => {
  let service: RefreshTokenService;
  let client: ReturnType<typeof makeFakeRedisClient>;

  beforeEach(async () => {
    client = makeFakeRedisClient();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        RefreshTokenService,
        { provide: RedisService, useValue: { client } },
        {
          provide: ConfigService,
          useValue: { get: () => 604_800 },
        },
      ],
    }).compile();
    service = moduleRef.get(RefreshTokenService);
  });

  it('mints a base64url token and stores it under sha256(token)', async () => {
    const { token, expiresInSeconds } = await service.mint('user-1');
    expect(typeof token).toBe('string');
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet
    expect(expiresInSeconds).toBe(604_800);
    expect(client._store.size).toBe(1);
    // Key MUST not contain the raw token (defence against Redis-dump leaks).
    const onlyKey = [...client._store.keys()][0] ?? '';
    expect(onlyKey).not.toContain(token);
    expect(onlyKey.startsWith('refresh:')).toBe(true);
  });

  it('rotation returns a fresh token and invalidates the old one', async () => {
    const minted = await service.mint('user-1');

    const first = await service.rotate(minted.token);
    expect(first.userId).toBe('user-1');
    expect(first.refresh.token).not.toBe(minted.token);

    // The original token is single-use — replaying must fail.
    await expect(service.rotate(minted.token)).rejects.toBeInstanceOf(UnauthorizedException);

    // The freshly minted token from the first rotation works.
    const second = await service.rotate(first.refresh.token);
    expect(second.userId).toBe('user-1');
  });

  it('rejects an unknown refresh token with 401', async () => {
    await expect(service.rotate('never-issued-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('revoke is safe to call with an unknown token', async () => {
    await expect(service.revoke('nope')).resolves.toBeUndefined();
  });

  it('revoke invalidates a previously minted token', async () => {
    const { token } = await service.mint('user-2');
    await service.revoke(token);
    await expect(service.rotate(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
