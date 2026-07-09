import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../infrastructure/database/schema/users.schema';
import { AuditRepository } from '../audit/audit.repository';
import { SecurityService } from '../security/security.service';
import type { SessionMeta } from '../sessions/refresh-token.service';
import { RefreshTokenService } from '../sessions/refresh-token.service';
import { UsersRepository } from '../users/users.repository';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

const meta: SessionMeta = { userAgent: 'Mozilla/5.0 (Test)', ip: '203.0.113.1' };

describe('AuthService', () => {
  let service: AuthService;
  let repo: {
    findByEmail: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };
  let usersService: {
    count: ReturnType<typeof vi.fn>;
    bootstrapAdmin: ReturnType<typeof vi.fn>;
  };
  let jwt: { signAsync: ReturnType<typeof vi.fn> };
  let refresh: {
    mint: ReturnType<typeof vi.fn>;
    rotate: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
  };
  let security: { verifyLoginChallenge: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };

  const password = 'correct-horse-battery-staple';
  let user: User;

  beforeEach(async () => {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    user = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'a@b.test',
      fullName: 'A',
      passwordHash,
      role: 'customer',
      resellerId: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      deletedAt: null,
    };
    repo = { findByEmail: vi.fn(), findById: vi.fn() };
    usersService = { count: vi.fn(), bootstrapAdmin: vi.fn() };
    jwt = { signAsync: vi.fn().mockResolvedValue('signed.jwt.value') };
    refresh = {
      mint: vi
        .fn()
        .mockResolvedValue({ token: 'refresh-A', expiresInSeconds: 604_800, sessionId: 'sess-A' }),
      rotate: vi.fn(),
      revoke: vi.fn().mockResolvedValue(null),
    };
    // Default: no 2FA challenge — matches every pre-existing regression test.
    security = { verifyLoginChallenge: vi.fn().mockResolvedValue('ok') };
    audit = { record: vi.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersRepository, useValue: repo },
        { provide: UsersService, useValue: usersService },
        { provide: JwtService, useValue: jwt },
        { provide: RefreshTokenService, useValue: refresh },
        { provide: SecurityService, useValue: security },
        { provide: AuditRepository, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  describe('login', () => {
    it('returns access + refresh token pair on valid credentials, minted for the request session', async () => {
      repo.findByEmail.mockResolvedValue(user);
      const out = await service.login(user.email, password, undefined, meta);
      expect(out.accessToken).toBe('signed.jwt.value');
      expect(out.refreshToken).toBe('refresh-A');
      expect(out.refreshExpiresInSeconds).toBe(604_800);
      expect(out.user).toEqual({
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        resellerId: null,
      });
      // The JWT carries the session id (SEC-2) so any authenticated
      // request can later identify "its own" session.
      expect(jwt.signAsync).toHaveBeenCalledWith({
        sub: user.id,
        role: user.role,
        sid: 'sess-A',
      });
      expect(refresh.mint).toHaveBeenCalledWith(user.id, meta);
    });

    // R8-OBS-2: a successful login must land a queryable `audit_log` row —
    // actor is the submitted email (forensic identity), not a field the
    // pino redact rules would strip.
    it('R8-OBS-2: persists an audit_log row with actor=email + outcome=success on a valid login', async () => {
      repo.findByEmail.mockResolvedValue(user);
      await service.login(user.email, password, undefined, meta);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: user.email,
          action: 'auth.login',
          entity: 'auth',
          entityId: user.id,
          summary: expect.stringContaining('success'),
        }),
      );
    });

    it('rejects with 401 when email is unknown', async () => {
      repo.findByEmail.mockResolvedValue(null);
      await expect(service.login('nope@b.test', password, undefined, meta)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(jwt.signAsync).not.toHaveBeenCalled();
      expect(refresh.mint).not.toHaveBeenCalled();
      // R8-OBS-2: still audited (failure) even though no user row exists —
      // and still no enumeration signal (same generic 'invalid_credentials'
      // reason as a wrong password below).
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: 'nope@b.test',
          action: 'auth.login',
          entity: 'auth',
          entityId: undefined,
          summary: expect.stringContaining('invalid_credentials'),
        }),
      );
    });

    it('rejects with 401 when password does not match', async () => {
      repo.findByEmail.mockResolvedValue(user);
      await expect(
        service.login(user.email, 'wrong-password', undefined, meta),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(jwt.signAsync).not.toHaveBeenCalled();
      expect(refresh.mint).not.toHaveBeenCalled();
      // R8-OBS-2 anti-enumeration: bad-password and unknown-email failures
      // must produce the IDENTICAL audit reason — no distinguishing signal
      // leaks into the trail either.
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: user.email,
          action: 'auth.login',
          entityId: undefined,
          summary: expect.stringContaining('invalid_credentials'),
        }),
      );
    });

    it('R8-OBS-2: a throwing audit write does not break login (best-effort)', async () => {
      repo.findByEmail.mockResolvedValue(user);
      audit.record.mockRejectedValue(new Error('db unavailable'));

      const out = await service.login(user.email, password, undefined, meta);
      expect(out.accessToken).toBe('signed.jwt.value');
    });

    describe('with two-factor enabled', () => {
      it('rejects with totp_required when no code is submitted, never touching the password-check-only path', async () => {
        repo.findByEmail.mockResolvedValue(user);
        security.verifyLoginChallenge.mockResolvedValue('required');

        const err = await service
          .login(user.email, password, undefined, meta)
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(UnauthorizedException);
        expect((err as UnauthorizedException).getResponse()).toMatchObject({
          code: 'totp_required',
        });
        expect(security.verifyLoginChallenge).toHaveBeenCalledWith(user.id, undefined);
        expect(jwt.signAsync).not.toHaveBeenCalled();
        expect(refresh.mint).not.toHaveBeenCalled();
      });

      it('rejects with totp_invalid when a wrong code is submitted', async () => {
        repo.findByEmail.mockResolvedValue(user);
        security.verifyLoginChallenge.mockResolvedValue('invalid');

        const err = await service
          .login(user.email, password, '000000', meta)
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(UnauthorizedException);
        expect((err as UnauthorizedException).getResponse()).toMatchObject({
          code: 'totp_invalid',
        });
        expect(security.verifyLoginChallenge).toHaveBeenCalledWith(user.id, '000000');
        expect(jwt.signAsync).not.toHaveBeenCalled();
        expect(refresh.mint).not.toHaveBeenCalled();
      });

      it('rejects with totp_locked when the account is brute-force locked out (F1), even with a code', async () => {
        repo.findByEmail.mockResolvedValue(user);
        security.verifyLoginChallenge.mockResolvedValue('locked');

        const err = await service
          .login(user.email, password, '123456', meta)
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(UnauthorizedException);
        expect((err as UnauthorizedException).getResponse()).toMatchObject({
          code: 'totp_locked',
        });
        expect(jwt.signAsync).not.toHaveBeenCalled();
        expect(refresh.mint).not.toHaveBeenCalled();
      });

      it('issues tokens when the code checks out (verification itself is SecurityService.verifyLoginChallenge — mocked here)', async () => {
        repo.findByEmail.mockResolvedValue(user);
        security.verifyLoginChallenge.mockResolvedValue('ok');

        const code = '123456';
        const out = await service.login(user.email, password, code, meta);

        expect(security.verifyLoginChallenge).toHaveBeenCalledWith(user.id, code);
        expect(out.accessToken).toBe('signed.jwt.value');
        expect(refresh.mint).toHaveBeenCalledWith(user.id, meta);
      });
    });
  });

  describe('refresh', () => {
    it('rotates the refresh token (same session id) and returns a fresh pair', async () => {
      refresh.rotate.mockResolvedValue({
        userId: user.id,
        sessionId: 'sess-A',
        refresh: { token: 'refresh-B', expiresInSeconds: 604_800, sessionId: 'sess-A' },
      });
      repo.findById.mockResolvedValue(user);

      const out = await service.refresh('refresh-A', meta);

      expect(refresh.rotate).toHaveBeenCalledWith('refresh-A', meta);
      expect(out.refreshToken).toBe('refresh-B');
      expect(out.accessToken).toBe('signed.jwt.value');
      expect(out.user.id).toBe(user.id);
      expect(jwt.signAsync).toHaveBeenCalledWith({ sub: user.id, role: user.role, sid: 'sess-A' });
      // R8-OBS-2: refresh also lands an audit_log row, actor = resolved userId.
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: user.id,
          action: 'auth.refresh',
          entity: 'auth',
          entityId: user.id,
        }),
      );
    });

    it('rejects with 401 when the rotated user no longer exists', async () => {
      refresh.rotate.mockResolvedValue({
        userId: user.id,
        sessionId: 'sess-A',
        refresh: { token: 'refresh-B', expiresInSeconds: 604_800, sessionId: 'sess-A' },
      });
      repo.findById.mockResolvedValue(null);

      await expect(service.refresh('refresh-A', meta)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('lets RefreshTokenService.rotate raise (unknown / replayed token)', async () => {
      refresh.rotate.mockRejectedValue(new UnauthorizedException('invalid refresh token'));
      await expect(service.refresh('stale-token', meta)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('revokes the supplied refresh token', async () => {
      await service.logout('refresh-Z', meta);
      expect(refresh.revoke).toHaveBeenCalledWith('refresh-Z');
    });

    it('R8-OBS-2: persists an auth.logout audit row with the resolved userId as actor', async () => {
      refresh.revoke.mockResolvedValue({ userId: user.id });
      await service.logout('refresh-Z', meta);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: user.id,
          action: 'auth.logout',
          entity: 'auth',
          entityId: user.id,
        }),
      );
    });

    it('R8-OBS-2: still audits (system actor) an unknown/already-revoked token, but never throws', async () => {
      refresh.revoke.mockResolvedValue(null);
      await service.logout('unknown-token', meta);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ actor: 'system', action: 'auth.logout' }),
      );
    });
  });

  describe('bootstrapRequired', () => {
    it('is true when there are no users', async () => {
      usersService.count.mockResolvedValue(0);
      await expect(service.bootstrapRequired()).resolves.toBe(true);
    });

    it('is false once any user exists', async () => {
      usersService.count.mockResolvedValue(3);
      await expect(service.bootstrapRequired()).resolves.toBe(false);
    });
  });

  describe('bootstrapAdmin', () => {
    const input = { email: 'root@ashnet.id', fullName: 'Root', password: 'correct-horse-staple' };

    it('creates the admin and logs them in (access + refresh pair)', async () => {
      usersService.bootstrapAdmin.mockResolvedValue({ ...user, role: 'admin' });
      const out = await service.bootstrapAdmin(input, meta);
      expect(usersService.bootstrapAdmin).toHaveBeenCalledWith(input);
      expect(out.accessToken).toBe('signed.jwt.value');
      expect(out.refreshToken).toBe('refresh-A');
      expect(out.user.role).toBe('admin');
      expect(refresh.mint).toHaveBeenCalledWith(user.id, meta);
    });

    it('rejects with 409 when a user already exists (returns null)', async () => {
      usersService.bootstrapAdmin.mockResolvedValue(null);
      await expect(service.bootstrapAdmin(input, meta)).rejects.toBeInstanceOf(ConflictException);
      expect(refresh.mint).not.toHaveBeenCalled();
    });
  });
});
