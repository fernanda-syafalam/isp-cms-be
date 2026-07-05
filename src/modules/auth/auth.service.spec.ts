import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../infrastructure/database/schema/users.schema';
import { UsersRepository } from '../users/users.repository';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { RefreshTokenService } from './refresh-token.service';

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
      mint: vi.fn().mockResolvedValue({ token: 'refresh-A', expiresInSeconds: 604_800 }),
      rotate: vi.fn(),
      revoke: vi.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersRepository, useValue: repo },
        { provide: UsersService, useValue: usersService },
        { provide: JwtService, useValue: jwt },
        { provide: RefreshTokenService, useValue: refresh },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  describe('login', () => {
    it('returns access + refresh token pair on valid credentials', async () => {
      repo.findByEmail.mockResolvedValue(user);
      const out = await service.login(user.email, password);
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
      expect(jwt.signAsync).toHaveBeenCalledWith({
        sub: user.id,
        role: user.role,
      });
      expect(refresh.mint).toHaveBeenCalledWith(user.id);
    });

    it('rejects with 401 when email is unknown', async () => {
      repo.findByEmail.mockResolvedValue(null);
      await expect(service.login('nope@b.test', password)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(jwt.signAsync).not.toHaveBeenCalled();
      expect(refresh.mint).not.toHaveBeenCalled();
    });

    it('rejects with 401 when password does not match', async () => {
      repo.findByEmail.mockResolvedValue(user);
      await expect(service.login(user.email, 'wrong-password')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(jwt.signAsync).not.toHaveBeenCalled();
      expect(refresh.mint).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('rotates the refresh token and returns a fresh pair', async () => {
      refresh.rotate.mockResolvedValue({
        userId: user.id,
        refresh: { token: 'refresh-B', expiresInSeconds: 604_800 },
      });
      repo.findById.mockResolvedValue(user);

      const out = await service.refresh('refresh-A');

      expect(refresh.rotate).toHaveBeenCalledWith('refresh-A');
      expect(out.refreshToken).toBe('refresh-B');
      expect(out.accessToken).toBe('signed.jwt.value');
      expect(out.user.id).toBe(user.id);
    });

    it('rejects with 401 when the rotated user no longer exists', async () => {
      refresh.rotate.mockResolvedValue({
        userId: user.id,
        refresh: { token: 'refresh-B', expiresInSeconds: 604_800 },
      });
      repo.findById.mockResolvedValue(null);

      await expect(service.refresh('refresh-A')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('lets RefreshTokenService.rotate raise (unknown / replayed token)', async () => {
      refresh.rotate.mockRejectedValue(new UnauthorizedException('invalid refresh token'));
      await expect(service.refresh('stale-token')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('revokes the supplied refresh token', async () => {
      await service.logout('refresh-Z');
      expect(refresh.revoke).toHaveBeenCalledWith('refresh-Z');
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
      const out = await service.bootstrapAdmin(input);
      expect(usersService.bootstrapAdmin).toHaveBeenCalledWith(input);
      expect(out.accessToken).toBe('signed.jwt.value');
      expect(out.refreshToken).toBe('refresh-A');
      expect(out.user.role).toBe('admin');
      expect(refresh.mint).toHaveBeenCalledWith(user.id);
    });

    it('rejects with 409 when a user already exists (returns null)', async () => {
      usersService.bootstrapAdmin.mockResolvedValue(null);
      await expect(service.bootstrapAdmin(input)).rejects.toBeInstanceOf(ConflictException);
      expect(refresh.mint).not.toHaveBeenCalled();
    });
  });
});
