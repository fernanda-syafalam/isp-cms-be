import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { createFakeRedisClient } from '../../test-utils/fake-redis-client';
import { RefreshTokenService } from './refresh-token.service';

describe('RefreshTokenService', () => {
  let service: RefreshTokenService;
  let client: ReturnType<typeof createFakeRedisClient>;

  const meta = { userAgent: 'Mozilla/5.0 (Test)', ip: '203.0.113.1' };

  beforeEach(async () => {
    client = createFakeRedisClient();
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
    const { token, expiresInSeconds, sessionId } = await service.mint('user-1', meta);
    expect(typeof token).toBe('string');
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet
    expect(expiresInSeconds).toBe(604_800);
    expect(typeof sessionId).toBe('string');
    // One refresh key + one session key.
    expect(client._store.size).toBe(2);
    const refreshKey = [...client._store.keys()].find((k) => k.startsWith('refresh:'));
    expect(refreshKey).toBeDefined();
    // Key MUST not contain the raw token (defence against Redis-dump leaks).
    expect(refreshKey).not.toContain(token);
  });

  it('rotation returns a fresh token and invalidates the old one', async () => {
    const minted = await service.mint('user-1', meta);

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
    await expect(service.revoke('nope')).resolves.toBeNull();
  });

  it('revoke invalidates a previously minted token and resolves the owning userId', async () => {
    const { token } = await service.mint('user-2', meta);
    await expect(service.revoke(token)).resolves.toEqual({ userId: 'user-2' });
    await expect(service.rotate(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  describe('session lifecycle (SEC-2)', () => {
    it('login creates a session with metadata, listed for that user', async () => {
      const { sessionId } = await service.mint('user-3', meta);

      const sessions = await service.listSessions('user-3');
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: sessionId,
        userAgent: meta.userAgent,
        ip: meta.ip,
      });
      expect(sessions[0]?.createdAt).toBe(sessions[0]?.lastUsedAt);
    });

    it('refresh (rotation) updates lastUsedAt on the SAME session, never duplicating it', async () => {
      const minted = await service.mint('user-4', meta);
      const before = await service.listSessions('user-4');
      expect(before).toHaveLength(1);
      const createdAt = before[0]?.createdAt;

      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.now() + 60_000));
      const rotated = await service.rotate(minted.token, { ...meta, ip: '198.51.100.7' });
      vi.useRealTimers();

      expect(rotated.sessionId).toBe(minted.sessionId);
      const after = await service.listSessions('user-4');
      expect(after).toHaveLength(1); // still exactly one session, not two
      expect(after[0]?.id).toBe(minted.sessionId);
      expect(after[0]?.createdAt).toBe(createdAt); // createdAt preserved
      expect(after[0]?.ip).toBe('198.51.100.7'); // lastUsedAt / ip refreshed
      expect(after[0]?.lastUsedAt).not.toBe(createdAt);
    });

    it('logout removes the session entry entirely', async () => {
      const { token } = await service.mint('user-5', meta);
      expect(await service.listSessions('user-5')).toHaveLength(1);

      await service.revoke(token);

      expect(await service.listSessions('user-5')).toHaveLength(0);
    });

    it('revokeSession deletes the backing refresh token, so it is rejected by rotate and does not resurrect the session', async () => {
      const a = await service.mint('user-6', meta);
      const b = await service.mint('user-6', meta);

      const existed = await service.revokeSession('user-6', a.sessionId);
      expect(existed).toBe(true);

      await expect(service.rotate(a.token)).rejects.toBeInstanceOf(UnauthorizedException);
      // The rejected rotate must NOT have re-created session `a` — only
      // the untouched session `b` remains.
      const remaining = await service.listSessions('user-6');
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe(b.sessionId);
      // The other session is untouched.
      await expect(service.rotate(b.token)).resolves.toMatchObject({ userId: 'user-6' });
    });

    it('revokeSession returns false for an unknown session id', async () => {
      await expect(service.revokeSession('user-7', 'never-existed')).resolves.toBe(false);
    });

    // SEC-RACE regression: revokeSession and rotate/commitMint must be
    // mutually atomic, so a rotate that is already "in flight" (its old
    // token already consumed via GETDEL) cannot resurrect a session that
    // gets revoked before the rotate's commit runs. Simulated here by
    // gating the ONE `client.get` call `commitMint` makes to read the
    // existing session record — the exact point between "old token
    // consumed" and "new token + session record committed" — and running
    // `revokeSession` to completion while `rotate` is parked there.
    it('SEC-RACE: a session revoked while a rotate is in flight is NOT resurrected by that rotate', async () => {
      const minted = await service.mint('user-race', meta);

      let releaseRotate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseRotate = resolve;
      });
      const realGet = client.get.getMockImplementation();
      client.get.mockImplementationOnce(async (key: string) => {
        await gate;
        return realGet ? realGet(key) : null;
      });

      // Kick off the rotate — it consumes the old token (GETDEL) and then
      // parks on the gated `get` inside `commitMint`, BEFORE its atomic
      // commit script runs.
      const rotatePromise = service.rotate(minted.token, meta);

      // While rotate is parked, the revoke runs to completion for real —
      // this is the "concurrent revoke" the SEC-RACE fix must survive.
      const revoked = await service.revokeSession('user-race', minted.sessionId);
      expect(revoked).toBe(true);

      // Only now let the parked rotate proceed to its atomic commit.
      releaseRotate();

      // The commit's membership guard must catch the concurrent revoke
      // and reject — NOT write a fresh token/session for the now-dead
      // session id.
      await expect(rotatePromise).rejects.toBeInstanceOf(UnauthorizedException);

      // No trace of the session survives — the revoke's outcome wins,
      // regardless of the rotate that was in flight against it.
      expect(await service.listSessions('user-race')).toHaveLength(0);
    });

    it('revokeOtherSessions revokes every session except the kept one', async () => {
      const kept = await service.mint('user-8', meta);
      const other1 = await service.mint('user-8', meta);
      const other2 = await service.mint('user-8', meta);

      const revoked = await service.revokeOtherSessions('user-8', kept.sessionId);
      expect(revoked).toBe(2);

      const sessions = await service.listSessions('user-8');
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe(kept.sessionId);

      // The kept session's token still works.
      await expect(service.rotate(kept.token)).resolves.toMatchObject({ userId: 'user-8' });
      // The revoked ones' tokens are dead.
      await expect(service.rotate(other1.token)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(service.rotate(other2.token)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('revokeOtherSessions revokes ALL sessions when no keepSessionId is given (degrades safely)', async () => {
      await service.mint('user-9', meta);
      await service.mint('user-9', meta);

      const revoked = await service.revokeOtherSessions('user-9', undefined);
      expect(revoked).toBe(2);
      expect(await service.listSessions('user-9')).toHaveLength(0);
    });

    it('lists sessions across different users independently', async () => {
      await service.mint('user-10', meta);
      await service.mint('user-11', meta);

      expect(await service.listSessions('user-10')).toHaveLength(1);
      expect(await service.listSessions('user-11')).toHaveLength(1);
    });
  });
});
