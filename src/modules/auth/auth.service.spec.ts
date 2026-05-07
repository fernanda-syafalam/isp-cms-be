import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../infrastructure/database/schema/users.schema';
import { UsersRepository } from '../users/users.repository';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let repo: { findByEmail: ReturnType<typeof vi.fn> };
  let jwt: { signAsync: ReturnType<typeof vi.fn> };

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
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      deletedAt: null,
    };
    repo = { findByEmail: vi.fn() };
    jwt = { signAsync: vi.fn().mockResolvedValue('signed.jwt.value') };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersRepository, useValue: repo },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  it('returns access token + user when credentials are valid', async () => {
    repo.findByEmail.mockResolvedValue(user);
    const out = await service.login(user.email, password);
    expect(out.accessToken).toBe('signed.jwt.value');
    expect(out.user).toEqual({ id: user.id, email: user.email, role: user.role });
    expect(jwt.signAsync).toHaveBeenCalledWith({ sub: user.id, role: user.role });
  });

  it('rejects with 401 when email is unknown', async () => {
    repo.findByEmail.mockResolvedValue(null);
    await expect(service.login('nope@b.test', password)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('rejects with 401 when password does not match', async () => {
    repo.findByEmail.mockResolvedValue(user);
    await expect(service.login(user.email, 'wrong-password')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });
});
