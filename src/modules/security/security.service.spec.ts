import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { authenticator } from 'otplib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserSession } from '../../infrastructure/database/schema/security.schema';
import { SecurityRepository } from './security.repository';
import { SecurityService } from './security.service';

const userId = '00000000-0000-0000-0000-0000000000a1';

const currentSession: UserSession = {
  id: '00000000-0000-0000-0000-0000000000s1',
  userId,
  device: 'Chrome di Windows',
  ip: '103.28.12.4',
  lastActiveAt: new Date('2026-06-16T00:00:00.000Z'),
  isCurrent: true,
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
};

describe('SecurityService', () => {
  let service: SecurityService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    repo = {
      ensureState: vi.fn(),
      findState: vi.fn(),
      saveTwoFactorSecret: vi.fn(),
      confirmTwoFactor: vi.fn(),
      clearTwoFactor: vi.fn(),
      countSessions: vi.fn(),
      seedSessions: vi.fn(),
      listSessions: vi.fn(),
      deleteSession: vi.fn(),
      deleteOtherSessions: vi.fn(),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [SecurityService, { provide: SecurityRepository, useValue: repo }],
    }).compile();
    service = moduleRef.get(SecurityService);
  });

  describe('getState', () => {
    it('seeds sessions on first access and maps isCurrent -> current with ISO dates', async () => {
      repo.countSessions.mockResolvedValue(0);
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: false });
      repo.listSessions.mockResolvedValue([currentSession]);

      const state = await service.getState(userId);

      expect(repo.ensureState).toHaveBeenCalledWith(userId);
      expect(repo.seedSessions).toHaveBeenCalledTimes(1);
      expect(state.twoFactorEnabled).toBe(false);
      expect(state.sessions[0]).toMatchObject({
        id: currentSession.id,
        device: 'Chrome di Windows',
        current: true,
        lastActiveAt: '2026-06-16T00:00:00.000Z',
      });
    });

    it('does not re-seed when sessions already exist', async () => {
      repo.countSessions.mockResolvedValue(2);
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: true });
      repo.listSessions.mockResolvedValue([currentSession]);

      const state = await service.getState(userId);

      expect(repo.seedSessions).not.toHaveBeenCalled();
      expect(state.twoFactorEnabled).toBe(true);
    });
  });

  describe('beginEnroll', () => {
    it('generates a secret, persists it, and returns the QR payload', async () => {
      repo.countSessions.mockResolvedValue(1);

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
      repo.countSessions.mockResolvedValue(1);
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: false,
        twoFactorSecret: secret,
      });
      repo.listSessions.mockResolvedValue([currentSession]);
      // Refresh after confirm reflects the flipped flag.
      repo.confirmTwoFactor.mockImplementation(async () => {
        repo.findState.mockResolvedValue({
          userId,
          twoFactorEnabled: true,
          twoFactorSecret: secret,
        });
      });

      const code = authenticator.generate(secret);
      const state = await service.confirmEnroll(userId, code);

      expect(repo.confirmTwoFactor).toHaveBeenCalledWith(userId);
      expect(state.twoFactorEnabled).toBe(true);
    });

    it('rejects a wrong code and does not enable 2FA', async () => {
      const secret = authenticator.generateSecret();
      repo.countSessions.mockResolvedValue(1);
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: false,
        twoFactorSecret: secret,
      });

      await expect(service.confirmEnroll(userId, '000000')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(repo.confirmTwoFactor).not.toHaveBeenCalled();
    });

    it('rejects when enrollment was never started (no stored secret)', async () => {
      repo.countSessions.mockResolvedValue(1);
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: false, twoFactorSecret: null });

      await expect(service.confirmEnroll(userId, '123456')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repo.confirmTwoFactor).not.toHaveBeenCalled();
    });
  });

  describe('disableTwoFactor', () => {
    it('clears the secret + flag when the current code is valid', async () => {
      const secret = authenticator.generateSecret();
      repo.countSessions.mockResolvedValue(1);
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: true, twoFactorSecret: secret });
      repo.listSessions.mockResolvedValue([currentSession]);
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
    });

    it('rejects disabling an enabled account with a missing/wrong code', async () => {
      const secret = authenticator.generateSecret();
      repo.countSessions.mockResolvedValue(1);
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: true, twoFactorSecret: secret });

      await expect(service.disableTwoFactor(userId, undefined)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(service.disableTwoFactor(userId, '000000')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(repo.clearTwoFactor).not.toHaveBeenCalled();
    });

    it('allows cancelling an unconfirmed enrollment without a code', async () => {
      repo.countSessions.mockResolvedValue(1);
      repo.findState.mockResolvedValue({
        userId,
        twoFactorEnabled: false,
        twoFactorSecret: 'SOMEUNCONFIRMEDSECRET',
      });
      repo.listSessions.mockResolvedValue([currentSession]);

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
    });

    it('returns ok when 2FA is enabled and the code is correct', async () => {
      const secret = authenticator.generateSecret();
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: true, twoFactorSecret: secret });
      const code = authenticator.generate(secret);
      await expect(service.verifyLoginChallenge(userId, code)).resolves.toBe('ok');
    });
  });

  describe('revokeSession', () => {
    it('deletes the session scoped to the user', async () => {
      repo.deleteSession.mockResolvedValue(true);
      await service.revokeSession(userId, 'sess-1');
      expect(repo.deleteSession).toHaveBeenCalledWith('sess-1', userId);
    });

    it('throws 404 when no session matched', async () => {
      repo.deleteSession.mockResolvedValue(false);
      await expect(service.revokeSession(userId, 'missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('revokeOtherSessions', () => {
    it('delegates to the repo', async () => {
      await service.revokeOtherSessions(userId);
      expect(repo.deleteOtherSessions).toHaveBeenCalledWith(userId);
    });
  });
});
