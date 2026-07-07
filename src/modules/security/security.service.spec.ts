import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { authenticator } from 'otplib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedisService } from '../../infrastructure/redis/redis.service';
import type { SessionSummary } from '../sessions/refresh-token.service';
import { RefreshTokenService } from '../sessions/refresh-token.service';
import { SecurityRepository } from './security.repository';
import { SecurityService } from './security.service';
import { TotpLockoutService } from './totp-lockout.service';

/** Minimal in-memory stand-in for `RedisService.client`'s get/incr/expire/del. */
function fakeRedisClient() {
  const store = new Map<string, number>();
  return {
    get: async (k: string) => (store.has(k) ? String(store.get(k)) : null),
    incr: async (k: string) => {
      const v = (store.get(k) ?? 0) + 1;
      store.set(k, v);
      return v;
    },
    expire: async () => 1,
    del: async (k: string) => (store.delete(k) ? 1 : 0),
  };
}

const userId = '00000000-0000-0000-0000-0000000000a1';

const currentSession: SessionSummary = {
  id: '00000000-0000-0000-0000-0000000000s1',
  createdAt: '2026-06-01T00:00:00.000Z',
  lastUsedAt: '2026-06-16T00:00:00.000Z',
  userAgent: 'Chrome on Windows',
  ip: '103.28.12.4',
};

const otherSession: SessionSummary = {
  id: '00000000-0000-0000-0000-0000000000s2',
  createdAt: '2026-06-02T00:00:00.000Z',
  lastUsedAt: '2026-06-10T00:00:00.000Z',
  userAgent: 'Safari on iPhone',
  ip: '103.28.12.9',
};

describe('SecurityService', () => {
  let service: SecurityService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let lockout: Record<string, ReturnType<typeof vi.fn>>;
  let sessions: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    repo = {
      ensureState: vi.fn(),
      findState: vi.fn(),
      saveTwoFactorSecret: vi.fn(),
      confirmTwoFactor: vi.fn(),
      clearTwoFactor: vi.fn(),
    };
    // Default: never locked — matches every pre-existing test that
    // doesn't care about F1. The dedicated 'F1 brute-force lockout'
    // describe block below wires a real TotpLockoutService instead.
    lockout = {
      isLocked: vi.fn().mockResolvedValue(false),
      recordFailure: vi.fn(),
      recordSuccess: vi.fn(),
    };
    sessions = {
      listSessions: vi.fn().mockResolvedValue([currentSession]),
      revokeSession: vi.fn(),
      revokeOtherSessions: vi.fn().mockResolvedValue(0),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SecurityService,
        { provide: SecurityRepository, useValue: repo },
        { provide: TotpLockoutService, useValue: lockout },
        { provide: RefreshTokenService, useValue: sessions },
      ],
    }).compile();
    service = moduleRef.get(SecurityService);
  });

  describe('getState', () => {
    it("returns the real active sessions, marking the caller's own as current", async () => {
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: false });
      sessions.listSessions.mockResolvedValue([currentSession, otherSession]);

      const state = await service.getState(userId, currentSession.id);

      expect(repo.ensureState).toHaveBeenCalledWith(userId);
      expect(sessions.listSessions).toHaveBeenCalledWith(userId);
      expect(state.twoFactorEnabled).toBe(false);
      expect(state.sessions).toHaveLength(2);
      expect(state.sessions.find((s) => s.id === currentSession.id)).toMatchObject({
        device: 'Chrome on Windows',
        ip: '103.28.12.4',
        lastActiveAt: '2026-06-16T00:00:00.000Z',
        current: true,
      });
      expect(state.sessions.find((s) => s.id === otherSession.id)).toMatchObject({
        current: false,
      });
    });

    it('marks no session as current when the caller has no session id (pre-SEC-2 access token)', async () => {
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: true });
      sessions.listSessions.mockResolvedValue([currentSession]);

      const state = await service.getState(userId, undefined);

      expect(state.sessions[0]?.current).toBe(false);
    });
  });

  describe('beginEnroll', () => {
    it('generates a secret, persists it, and returns the QR payload', async () => {
      const out = await service.beginEnroll(userId, 'user@example.test');

      expect(repo.saveTwoFactorSecret).toHaveBeenCalledWith(userId, out.twoFactorSecret);
      expect(out.twoFactorSecret).toMatch(/^[A-Z2-7]+$/); // base32
      expect(out.otpauthUri).toContain('otpauth://totp/');
      expect(out.otpauthUri).toContain(encodeURIComponent('user@example.test'));
    });
  });

  describe('confirmEnroll', () => {
    it('flips enabled to true when the code matches the stored secret', async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: false,
        twoFactorSecret: secret,
      });
      // Refresh after confirm reflects the flipped flag.
      repo.confirmTwoFactor.mockImplementation(async () => {
        repo.findState.mockResolvedValue({
          userId,
          twoFactorEnabled: true,
          twoFactorSecret: secret,
        });
      });

      const code = authenticator.generate(secret);
      const state = await service.confirmEnroll(userId, code, currentSession.id);

      expect(repo.confirmTwoFactor).toHaveBeenCalledWith(userId);
      expect(state.twoFactorEnabled).toBe(true);
      expect(lockout.recordSuccess).toHaveBeenCalledWith(userId);
      expect(lockout.recordFailure).not.toHaveBeenCalled();
    });

    it("F3: revokes every other active session, keeping only the caller's own", async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: false,
        twoFactorSecret: secret,
      });
      sessions.revokeOtherSessions.mockResolvedValue(2);

      const code = authenticator.generate(secret);
      await service.confirmEnroll(userId, code, currentSession.id);

      expect(sessions.revokeOtherSessions).toHaveBeenCalledWith(userId, currentSession.id);
      // Revoke must happen AFTER the flag actually flips, not before.
      const confirmOrder = repo.confirmTwoFactor.mock.invocationCallOrder[0];
      const revokeOrder = sessions.revokeOtherSessions.mock.invocationCallOrder[0];
      expect(confirmOrder).toBeLessThan(revokeOrder as number);
    });

    it('rejects a wrong code and does not enable 2FA or touch sessions', async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: false,
        twoFactorSecret: secret,
      });

      await expect(
        service.confirmEnroll(userId, '000000', currentSession.id),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(repo.confirmTwoFactor).not.toHaveBeenCalled();
      expect(sessions.revokeOtherSessions).not.toHaveBeenCalled();
      expect(lockout.recordFailure).toHaveBeenCalledWith(userId);
    });

    it('rejects when enrollment was never started (no stored secret)', async () => {
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: false, twoFactorSecret: null });

      await expect(service.confirmEnroll(userId, '123456')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repo.confirmTwoFactor).not.toHaveBeenCalled();
      // No secret exists yet to check the code against — never touches the lockout.
      expect(lockout.recordFailure).not.toHaveBeenCalled();
    });

    it('rejects with totp_locked (and does not verify the code) when the account is locked out', async () => {
      lockout.isLocked.mockResolvedValue(true);
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: false,
        twoFactorSecret: 'ANYSECRET',
      });

      const err = await service.confirmEnroll(userId, '123456').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).getResponse()).toMatchObject({ code: 'totp_locked' });
      expect(repo.confirmTwoFactor).not.toHaveBeenCalled();
      expect(lockout.recordFailure).not.toHaveBeenCalled();
    });
  });

  describe('disableTwoFactor', () => {
    it('clears the secret + flag when the current code is valid', async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: true, twoFactorSecret: secret });
      repo.clearTwoFactor.mockImplementation(async () => {
        repo.findState.mockResolvedValue({
          userId,
          twoFactorEnabled: false,
          twoFactorSecret: null,
        });
      });

      const code = authenticator.generate(secret);
      const state = await service.disableTwoFactor(userId, code);

      expect(repo.clearTwoFactor).toHaveBeenCalledWith(userId);
      expect(state.twoFactorEnabled).toBe(false);
      expect(lockout.recordSuccess).toHaveBeenCalledWith(userId);
    });

    it('rejects disabling an enabled account with a missing/wrong code', async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: true, twoFactorSecret: secret });

      await expect(service.disableTwoFactor(userId, undefined)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(service.disableTwoFactor(userId, '000000')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(repo.clearTwoFactor).not.toHaveBeenCalled();
      expect(lockout.recordFailure).toHaveBeenCalledTimes(2);
    });

    it('rejects with totp_locked when the account is locked out, without touching the repo', async () => {
      lockout.isLocked.mockResolvedValue(true);
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: true, twoFactorSecret: secret });

      const code = authenticator.generate(secret); // even the correct code
      const err = await service.disableTwoFactor(userId, code).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).getResponse()).toMatchObject({ code: 'totp_locked' });
      expect(repo.clearTwoFactor).not.toHaveBeenCalled();
    });

    it('allows cancelling an unconfirmed enrollment without a code, even while locked', async () => {
      lockout.isLocked.mockResolvedValue(true);
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: false,
        twoFactorSecret: 'SOMEUNCONFIRMEDSECRET',
      });

      const state = await service.disableTwoFactor(userId);

      expect(repo.clearTwoFactor).toHaveBeenCalledWith(userId);
      expect(state.twoFactorEnabled).toBe(false);
    });
  });

  describe('verifyLoginChallenge', () => {
    it('returns ok when the user has no 2FA enabled, regardless of code', async () => {
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: false, twoFactorSecret: null });
      await expect(service.verifyLoginChallenge(userId)).resolves.toBe('ok');
      await expect(service.verifyLoginChallenge(userId, '000000')).resolves.toBe('ok');
    });

    it('returns required when 2FA is enabled and no code was submitted', async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: true, twoFactorSecret: secret });
      await expect(service.verifyLoginChallenge(userId)).resolves.toBe('required');
    });

    it('returns invalid when 2FA is enabled and the code is wrong', async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: true, twoFactorSecret: secret });
      await expect(service.verifyLoginChallenge(userId, '000000')).resolves.toBe('invalid');
      expect(lockout.recordFailure).toHaveBeenCalledWith(userId);
    });

    it('returns ok when 2FA is enabled and the code is correct', async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: true, twoFactorSecret: secret });
      const code = authenticator.generate(secret);
      await expect(service.verifyLoginChallenge(userId, code)).resolves.toBe('ok');
      expect(lockout.recordSuccess).toHaveBeenCalledWith(userId);
    });

    it('returns locked (and never verifies the code) when the account is locked out', async () => {
      lockout.isLocked.mockResolvedValue(true);
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: true, twoFactorSecret: secret });
      const code = authenticator.generate(secret); // even the correct code
      await expect(service.verifyLoginChallenge(userId, code)).resolves.toBe('locked');
      expect(lockout.recordSuccess).not.toHaveBeenCalled();
      expect(lockout.recordFailure).not.toHaveBeenCalled();
    });

    it('does not count a missing code (required) against the lockout', async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: true, twoFactorSecret: secret });
      await expect(service.verifyLoginChallenge(userId)).resolves.toBe('required');
      expect(lockout.isLocked).not.toHaveBeenCalled();
      expect(lockout.recordFailure).not.toHaveBeenCalled();
    });

    // F4 regression: fail CLOSED, never open. An enabled=true row with a
    // null secret is an anomaly (should be unreachable via the normal
    // enroll/confirm path) — it must NOT let a login through, with or
    // without a submitted code.
    it('fails closed (never ok) when enabled is true but the stored secret is null', async () => {
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: true, twoFactorSecret: null });
      await expect(service.verifyLoginChallenge(userId)).resolves.not.toBe('ok');
      await expect(service.verifyLoginChallenge(userId, '123456')).resolves.not.toBe('ok');
      await expect(service.verifyLoginChallenge(userId, '123456')).resolves.toBe('invalid');
    });
  });

  // Real TotpLockoutService (backed by an in-memory fake redis client) instead
  // of the mocked `lockout` used everywhere above — proves the actual
  // failure-counting/threshold/reset behavior, not just that SecurityService
  // calls the right methods.
  describe('F1 brute-force lockout (real TotpLockoutService)', () => {
    let realService: SecurityService;

    beforeEach(async () => {
      const fakeRedis = { client: fakeRedisClient() } as unknown as RedisService;
      const realLockout = new TotpLockoutService(fakeRedis);
      realService = new SecurityService(
        repo as unknown as SecurityRepository,
        realLockout,
        sessions as unknown as RefreshTokenService,
      );
    });

    it('locks the account out after 5 consecutive failures and blocks even a correct code, until the counter resets', async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: true, twoFactorSecret: secret });

      for (let i = 0; i < TotpLockoutService.MAX_ATTEMPTS; i++) {
        await expect(realService.verifyLoginChallenge(userId, '000000')).resolves.toBe('invalid');
      }

      // The 6th attempt is locked out — even with the objectively correct code.
      const rightCode = authenticator.generate(secret);
      await expect(realService.verifyLoginChallenge(userId, rightCode)).resolves.toBe('locked');
    });

    it('resets the counter on a successful verification, so a later run needs the full threshold again', async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: true, twoFactorSecret: secret });

      // A few failures, short of the threshold...
      await realService.verifyLoginChallenge(userId, '000000');
      await realService.verifyLoginChallenge(userId, '000000');
      // ...then a success clears the counter.
      const rightCode = authenticator.generate(secret);
      await expect(realService.verifyLoginChallenge(userId, rightCode)).resolves.toBe('ok');

      // The next failure run starts from zero, not from where it left off.
      for (let i = 0; i < TotpLockoutService.MAX_ATTEMPTS - 1; i++) {
        await expect(realService.verifyLoginChallenge(userId, '000000')).resolves.toBe('invalid');
      }
      // Still one short of the threshold — the earlier 2 failures were wiped.
      await expect(realService.verifyLoginChallenge(userId, rightCode)).resolves.toBe('ok');
    });

    it('tracks lockout independently per user', async () => {
      const secretA = authenticator.generateSecret();
      const userA = userId;
      const userB = '00000000-0000-0000-0000-0000000000b9';

      repo.findState.mockImplementation(async (id: string) => ({
        userId: id,
        twoFactorEnabled: true,
        twoFactorSecret: secretA,
      }));

      for (let i = 0; i < TotpLockoutService.MAX_ATTEMPTS; i++) {
        await realService.verifyLoginChallenge(userA, '000000');
      }
      await expect(
        realService.verifyLoginChallenge(userA, authenticator.generate(secretA)),
      ).resolves.toBe('locked');
      // userB never failed — unaffected.
      await expect(
        realService.verifyLoginChallenge(userB, authenticator.generate(secretA)),
      ).resolves.toBe('ok');
    });
  });

  describe('revokeSession', () => {
    it('delegates to the real session store, scoped to the user', async () => {
      sessions.revokeSession.mockResolvedValue(true);
      await service.revokeSession(userId, 'sess-1');
      expect(sessions.revokeSession).toHaveBeenCalledWith(userId, 'sess-1');
    });

    it('throws 404 when no session matched', async () => {
      sessions.revokeSession.mockResolvedValue(false);
      await expect(service.revokeSession(userId, 'missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('revokeOtherSessions', () => {
    it("delegates to the real session store, keeping the caller's own session", async () => {
      await service.revokeOtherSessions(userId, currentSession.id);
      expect(sessions.revokeOtherSessions).toHaveBeenCalledWith(userId, currentSession.id);
    });
  });
});
