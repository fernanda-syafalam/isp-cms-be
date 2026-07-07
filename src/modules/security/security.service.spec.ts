import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { authenticator } from 'otplib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/configuration';
import type { RedisService } from '../../infrastructure/redis/redis.service';
import type { SessionSummary } from '../sessions/refresh-token.service';
import { RefreshTokenService } from '../sessions/refresh-token.service';
import { SecurityRepository } from './security.repository';
import { SecurityService } from './security.service';
import { TotpLockoutService } from './totp-lockout.service';
import { TotpReplayGuardService } from './totp-replay-guard.service';
import { TotpSecretCipherService } from './totp-secret-cipher.service';

/**
 * Minimal in-memory stand-in for `RedisService.client`'s
 * get/set/incr/expire/del, PLUS the single-key `eval` script
 * `TotpReplayGuardService.acceptStep` issues (numkeys === 1 — see that
 * service's `ACCEPT_STEP_SCRIPT` doc comment). Mirrors
 * `src/test-utils/fake-redis-client.ts`'s dispatch-by-numkeys approach,
 * kept local here since this file only ever needs the 1-key script, not
 * `RefreshTokenService`'s 2/3-key ones.
 */
function fakeRedisClient() {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => (store.has(k) ? String(store.get(k)) : null),
    set: async (k: string, v: string) => {
      store.set(k, v);
      return 'OK' as const;
    },
    incr: async (k: string) => {
      const v = Number(store.get(k) ?? '0') + 1;
      store.set(k, String(v));
      return v;
    },
    expire: async () => 1,
    del: async (k: string) => (store.delete(k) ? 1 : 0),
    eval: async (_script: string, numkeys: number, ...rest: Array<string | number>) => {
      const keys = rest.slice(0, numkeys).map(String);
      const args = rest.slice(numkeys).map(String);
      // Only one script ever reaches this fake: TotpReplayGuardService's
      // accept-step compare-and-set. KEYS = [key], ARGV = [step, ttl].
      const [key] = keys as [string];
      const [stepStr] = args as [string, string];
      const last = store.get(key);
      if (last !== undefined && Number(last) >= Number(stepStr)) {
        return 0;
      }
      store.set(key, stepStr);
      return 1;
    },
  };
}

// F2: a fixed 32-byte (base64) key so `TotpSecretCipherService` can
// actually encrypt/decrypt in these unit tests — same value as
// `test/setup.ts`'s `TWOFA_ENC_KEY` default, but constructed directly
// here rather than read from `process.env` (this is a plain `new`, not
// DI-resolved, same as the real `TotpLockoutService` further down).
const TEST_ENC_KEY = 'vnteJd7CUd7akqlbonvugRw6MNVSqV88K3ijn82XeoM=';

function makeCipher(): TotpSecretCipherService {
  const configStub = { get: () => TEST_ENC_KEY } as unknown as ConfigService<
    { app: AppConfig },
    true
  >;
  return new TotpSecretCipherService(configStub);
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
  let cipher: TotpSecretCipherService;
  let replayGuard: Record<string, ReturnType<typeof vi.fn>>;

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
    // F2: real cipher (not mocked) — these tests need actual
    // encrypt/decrypt round-tripping, not just "was it called".
    cipher = makeCipher();
    // F5: default — never a replay, matches every pre-existing test that
    // doesn't care about F5. The dedicated 'F5 replay protection'
    // describe block below wires a real TotpReplayGuardService instead.
    replayGuard = {
      acceptStep: vi.fn().mockResolvedValue(true),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SecurityService,
        { provide: SecurityRepository, useValue: repo },
        { provide: TotpLockoutService, useValue: lockout },
        { provide: RefreshTokenService, useValue: sessions },
        { provide: TotpSecretCipherService, useValue: cipher },
        { provide: TotpReplayGuardService, useValue: replayGuard },
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

      expect(out.twoFactorSecret).toMatch(/^[A-Z2-7]+$/); // base32
      expect(out.otpauthUri).toContain('otpauth://totp/');
      expect(out.otpauthUri).toContain(encodeURIComponent('user@example.test'));

      // F2: the DB never sees the plaintext secret — only an encrypted
      // blob that decrypts back to the same value returned to the caller.
      expect(repo.saveTwoFactorSecret).toHaveBeenCalledWith(userId, expect.any(String));
      const stored = repo.saveTwoFactorSecret.mock.calls[0]?.[1] as string;
      expect(stored).not.toBe(out.twoFactorSecret);
      expect(stored).not.toMatch(/^[A-Z2-7]+$/); // not plain base32
      expect(cipher.decrypt(stored)).toBe(out.twoFactorSecret);
    });
  });

  describe('confirmEnroll', () => {
    it('flips enabled to true when the code matches the stored secret', async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: false,
        twoFactorSecret: cipher.encrypt(secret),
      });
      // Refresh after confirm reflects the flipped flag.
      repo.confirmTwoFactor.mockImplementation(async () => {
        repo.findState.mockResolvedValue({
          userId,
          twoFactorEnabled: true,
          twoFactorSecret: cipher.encrypt(secret),
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
        twoFactorSecret: cipher.encrypt(secret),
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
        twoFactorSecret: cipher.encrypt(secret),
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

    // F2: defensive handling for a legacy plaintext secret (or any other
    // corrupted value) stored before encryption-at-rest shipped — must
    // fail the challenge safely, never crash, never let it through.
    it('fails safely (not a crash, not a pass) when the stored secret is a legacy plaintext value', async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: false,
        twoFactorSecret: secret, // plaintext, not `iv:authTag:ciphertext`
      });

      const code = authenticator.generate(secret); // objectively correct code
      await expect(service.confirmEnroll(userId, code)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(repo.confirmTwoFactor).not.toHaveBeenCalled();
      // An anomaly outside the user's control — does not burn a lockout attempt.
      expect(lockout.recordFailure).not.toHaveBeenCalled();
    });
  });

  describe('disableTwoFactor', () => {
    it('clears the secret + flag when the current code is valid', async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: true,
        twoFactorSecret: cipher.encrypt(secret),
      });
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
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: true,
        twoFactorSecret: cipher.encrypt(secret),
      });

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

    // F2: same defensive handling as confirmEnroll — a legacy plaintext
    // (or otherwise corrupted) secret must fail closed, not crash.
    it('fails safely when the stored secret is a legacy plaintext value', async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: true,
        twoFactorSecret: secret, // plaintext, not `iv:authTag:ciphertext`
      });

      const code = authenticator.generate(secret); // objectively correct code
      await expect(service.disableTwoFactor(userId, code)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
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
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: true,
        twoFactorSecret: cipher.encrypt(secret),
      });
      await expect(service.verifyLoginChallenge(userId, '000000')).resolves.toBe('invalid');
      expect(lockout.recordFailure).toHaveBeenCalledWith(userId);
    });

    it('returns ok when 2FA is enabled and the code is correct', async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: true,
        twoFactorSecret: cipher.encrypt(secret),
      });
      const code = authenticator.generate(secret);
      await expect(service.verifyLoginChallenge(userId, code)).resolves.toBe('ok');
      expect(lockout.recordSuccess).toHaveBeenCalledWith(userId);
    });

    // F2: a legacy plaintext (or otherwise corrupted) secret must fail the
    // challenge safely — never crash, never let it through as 'ok' — and
    // must not burn a lockout attempt (it's not the user's fault).
    it("fails safely ('invalid', no crash) when the stored secret is a legacy plaintext value", async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: true,
        twoFactorSecret: secret, // plaintext, not `iv:authTag:ciphertext`
      });
      const code = authenticator.generate(secret); // objectively correct code
      await expect(service.verifyLoginChallenge(userId, code)).resolves.toBe('invalid');
      expect(lockout.recordFailure).not.toHaveBeenCalled();
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
        cipher,
        // F5 is exercised in its own describe block below — the mocked,
        // never-a-replay `replayGuard` here keeps this block focused on
        // F1 only (in particular, reusing the same `rightCode` value
        // across assertions within a test must not itself look like a
        // replay).
        replayGuard as unknown as TotpReplayGuardService,
      );
    });

    it('locks the account out after 5 consecutive failures and blocks even a correct code, until the counter resets', async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: true,
        twoFactorSecret: cipher.encrypt(secret),
      });

      for (let i = 0; i < TotpLockoutService.MAX_ATTEMPTS; i++) {
        await expect(realService.verifyLoginChallenge(userId, '000000')).resolves.toBe('invalid');
      }

      // The 6th attempt is locked out — even with the objectively correct code.
      const rightCode = authenticator.generate(secret);
      await expect(realService.verifyLoginChallenge(userId, rightCode)).resolves.toBe('locked');
    });

    it('resets the counter on a successful verification, so a later run needs the full threshold again', async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: true,
        twoFactorSecret: cipher.encrypt(secret),
      });

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
        twoFactorSecret: cipher.encrypt(secretA),
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

  // Real TotpReplayGuardService (backed by an in-memory fake redis client)
  // instead of the mocked `replayGuard` used everywhere above — proves the
  // actual step-tracking/replay-rejection behavior, not just that
  // SecurityService calls the right methods. Time is faked (`Date` only,
  // via `toFake: ['Date']`) so each test controls exactly which TOTP step
  // a generated code lands on, instead of racing the real clock.
  describe('F5 TOTP replay protection (real TotpReplayGuardService)', () => {
    let realService: SecurityService;

    beforeEach(async () => {
      const fakeRedis = { client: fakeRedisClient() } as unknown as RedisService;
      const realReplayGuard = new TotpReplayGuardService(fakeRedis);
      realService = new SecurityService(
        repo as unknown as SecurityRepository,
        lockout as unknown as TotpLockoutService,
        sessions as unknown as RefreshTokenService,
        cipher,
        realReplayGuard,
      );
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejects an immediate replay of an already-accepted code', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: true,
        twoFactorSecret: cipher.encrypt(secret),
      });
      const code = authenticator.generate(secret);

      await expect(realService.verifyLoginChallenge(userId, code)).resolves.toBe('ok');
      // Same code, same step — rejected as a replay, not accepted again.
      await expect(realService.verifyLoginChallenge(userId, code)).resolves.toBe('invalid');
      // F5 judgment call (see PR description): a replay is the user's own
      // code re-submitted, not a guess — it does not burn a lockout attempt.
      expect(lockout.recordFailure).not.toHaveBeenCalled();
    });

    // M1 regression: the accept-step compare-and-set must be atomic — two
    // concurrent requests bearing the SAME still-valid code must not both
    // be accepted. `TotpReplayGuardService.acceptStep` does the read +
    // compare + write as one Redis `EVAL`, so even "concurrent" calls from
    // this test's point of view resolve to exactly one acceptance.
    it('accepts at most one of two concurrent verifications for the same step', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: true,
        twoFactorSecret: cipher.encrypt(secret),
      });
      const code = authenticator.generate(secret);

      const [first, second] = await Promise.all([
        realService.verifyLoginChallenge(userId, code),
        realService.verifyLoginChallenge(userId, code),
      ]);

      const results = [first, second];
      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
      expect(results.filter((r) => r === 'invalid')).toHaveLength(1);
    });

    it('accepts a fresh code at a later step after a previous one was accepted', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: true,
        twoFactorSecret: cipher.encrypt(secret),
      });

      const firstCode = authenticator.generate(secret);
      await expect(realService.verifyLoginChallenge(userId, firstCode)).resolves.toBe('ok');

      vi.setSystemTime(new Date('2026-01-01T00:00:31.000Z')); // one 30s step later
      const laterCode = authenticator.generate(secret);
      await expect(realService.verifyLoginChallenge(userId, laterCode)).resolves.toBe('ok');
    });

    it("rejects a stale code for an already-accepted step even when it is still inside otplib's own ±1 window", async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: true,
        twoFactorSecret: cipher.encrypt(secret),
      });

      const firstCode = authenticator.generate(secret);
      await expect(realService.verifyLoginChallenge(userId, firstCode)).resolves.toBe('ok');

      // One step later: `firstCode` is still inside otplib's own ±1
      // window relative to "now" (window: 1 tolerates the previous
      // step), so otplib alone would happily accept it again — the
      // replay guard is what actually stops it.
      vi.setSystemTime(new Date('2026-01-01T00:00:31.000Z'));
      await expect(realService.verifyLoginChallenge(userId, firstCode)).resolves.toBe('invalid');
      expect(lockout.recordFailure).not.toHaveBeenCalled();
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
