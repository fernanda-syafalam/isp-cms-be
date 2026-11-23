import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/configuration';
import type { User } from '../../infrastructure/database/schema/users.schema';
import type { UsersRepository } from '../users/users.repository';
import { JwtStrategy } from './jwt.strategy';

const baseUser: User = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'a@b.test',
  fullName: 'A',
  passwordHash: 'irrelevant',
  role: 'admin',
  resellerId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  deletedAt: null,
};

function build(user: User | null): JwtStrategy {
  const config = { get: () => 'test-secret' } as unknown as ConfigService<{ app: AppConfig }, true>;
  const repo = { findById: vi.fn().mockResolvedValue(user) } as unknown as UsersRepository;
  return new JwtStrategy(config, repo);
}

const payload = (role: User['role']) => ({ sub: baseUser.id, role, iat: 0, exp: 9_999_999_999 });

describe('JwtStrategy.validate', () => {
  it.each(['mitra', 'customer'] as const)(
    'rejects an existing %s access token with 401',
    async (role) => {
      const strategy = build({ ...baseUser, role });
      await expect(strategy.validate(payload(role))).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );

  it.each(['admin', 'staff', 'teknisi'] as const)('accepts %s', async (role) => {
    const strategy = build({ ...baseUser, role });
    const out = await strategy.validate(payload(role));
    expect(out.role).toBe(role);
  });

  it('rejects when the stored role is disabled even if the token claims an enabled role', async () => {
    const strategy = build({ ...baseUser, role: 'mitra' });
    await expect(strategy.validate(payload('admin'))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
