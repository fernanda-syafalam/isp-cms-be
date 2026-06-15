import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
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
      setTwoFactor: vi.fn(),
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

  describe('two-factor', () => {
    it('enables 2FA and returns the refreshed state', async () => {
      repo.countSessions.mockResolvedValue(1);
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: true });
      repo.listSessions.mockResolvedValue([currentSession]);

      const state = await service.enableTwoFactor(userId, '123456');

      expect(repo.setTwoFactor).toHaveBeenCalledWith(userId, true);
      expect(state.twoFactorEnabled).toBe(true);
    });

    it('disables 2FA', async () => {
      repo.countSessions.mockResolvedValue(1);
      repo.findState.mockResolvedValue({ userId, twoFactorEnabled: false });
      repo.listSessions.mockResolvedValue([currentSession]);

      const state = await service.disableTwoFactor(userId);

      expect(repo.setTwoFactor).toHaveBeenCalledWith(userId, false);
      expect(state.twoFactorEnabled).toBe(false);
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
