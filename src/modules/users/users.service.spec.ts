import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../infrastructure/database/schema/users.schema';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

const sampleUser: User = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'a@b.test',
  fullName: 'A B',
  passwordHash: '$argon2id$v=19$...',
  role: 'customer',
  resellerId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  deletedAt: null,
};

describe('UsersService', () => {
  let service: UsersService;
  let repo: {
    findById: ReturnType<typeof vi.fn>;
    findByEmail: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    countAll: ReturnType<typeof vi.fn>;
    createIfEmpty: ReturnType<typeof vi.fn>;
    listPage: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    softDelete: ReturnType<typeof vi.fn>;
    updatePasswordHash: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    repo = {
      findById: vi.fn(),
      findByEmail: vi.fn(),
      create: vi.fn(),
      countAll: vi.fn(),
      createIfEmpty: vi.fn(),
      listPage: vi.fn(),
      update: vi.fn(),
      softDelete: vi.fn(),
      updatePasswordHash: vi.fn(),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: UsersRepository, useValue: repo }],
    }).compile();
    service = moduleRef.get(UsersService);
  });

  describe('create', () => {
    it('hashes the password and inserts a new user', async () => {
      repo.findByEmail.mockResolvedValue(null);
      repo.create.mockResolvedValue(sampleUser);

      const created = await service.create({
        email: 'a@b.test',
        fullName: 'A B',
        password: 'correct horse battery staple',
        role: 'customer',
      });

      expect(created).toEqual(sampleUser);
      expect(repo.create).toHaveBeenCalledTimes(1);
      const call = repo.create.mock.calls[0]?.[0];
      expect(call?.passwordHash).toMatch(/^\$argon2id\$/);
      // Sanity check: the plain password must never be stored.
      expect(call?.passwordHash).not.toContain('correct horse');
    });

    it('rejects when email is already taken', async () => {
      repo.findByEmail.mockResolvedValue(sampleUser);
      await expect(
        service.create({
          email: sampleUser.email,
          fullName: 'X',
          password: 'a-fresh-password-here',
          role: 'customer',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('normalizes email (trim + lowercase) before the conflict check and the insert', async () => {
      repo.findByEmail.mockResolvedValue(null);
      repo.create.mockResolvedValue(sampleUser);

      await service.create({
        email: '  Bob@X.com  ',
        fullName: 'Bob',
        password: 'correct horse battery staple',
        role: 'customer',
      });

      expect(repo.findByEmail).toHaveBeenCalledWith('bob@x.com');
      const call = repo.create.mock.calls[0]?.[0];
      expect(call?.email).toBe('bob@x.com');
    });
  });

  describe('bootstrapAdmin', () => {
    it('normalizes email (trim + lowercase) before the first-admin insert', async () => {
      repo.countAll.mockResolvedValue(0);
      repo.createIfEmpty.mockResolvedValue({ ...sampleUser, role: 'admin' });

      await service.bootstrapAdmin({
        email: '  Root@Admin.test  ',
        fullName: 'Root',
        password: 'correct horse battery staple',
      });

      const call = repo.createIfEmpty.mock.calls[0]?.[0];
      expect(call?.email).toBe('root@admin.test');
      expect(call?.role).toBe('admin');
    });

    it('returns null without hashing when a user already exists', async () => {
      repo.countAll.mockResolvedValue(1);

      const result = await service.bootstrapAdmin({
        email: 'root@admin.test',
        fullName: 'Root',
        password: 'correct horse battery staple',
      });

      expect(result).toBeNull();
      expect(repo.createIfEmpty).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('patches the profile and returns the updated user', async () => {
      const updated = {
        ...sampleUser,
        fullName: 'New Name',
        role: 'staff' as const,
      };
      repo.update.mockResolvedValue(updated);

      await expect(
        service.update(sampleUser.id, { fullName: 'New Name', role: 'staff' }),
      ).resolves.toEqual(updated);
      expect(repo.update).toHaveBeenCalledWith(sampleUser.id, {
        fullName: 'New Name',
        role: 'staff',
      });
    });

    it('propagates 404 from the repository for a missing user', async () => {
      repo.update.mockRejectedValue(new NotFoundException('user not found'));
      await expect(service.update('missing', { role: 'admin' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('findById', () => {
    it('returns the user when present', async () => {
      repo.findById.mockResolvedValue(sampleUser);
      await expect(service.findById(sampleUser.id)).resolves.toBe(sampleUser);
    });

    it('throws 404 when missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.findById('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('hash compatibility', () => {
    // Sanity check the argon2 binding is wired and the chosen
    // parameters produce a verifiable hash. Slow (~50 ms) but only one
    // case so cost is bounded.
    it('produces a hash that argon2.verify accepts', async () => {
      repo.findByEmail.mockResolvedValue(null);
      repo.create.mockImplementation(async (input) => ({
        ...sampleUser,
        ...input,
      }));

      const created = await service.create({
        email: 'verify@test',
        fullName: 'V',
        password: 'another-secret-pass-9',
        role: 'customer',
      });

      const ok = await argon2.verify(created.passwordHash, 'another-secret-pass-9');
      expect(ok).toBe(true);
    });
  });

  describe('changePassword (P1.4)', () => {
    it('verifies the current password and stores a new argon2id hash', async () => {
      const currentHash = await argon2.hash('old-password-12ch', { type: argon2.argon2id });
      repo.findById.mockResolvedValue({ ...sampleUser, passwordHash: currentHash });

      await service.changePassword(sampleUser.id, 'old-password-12ch', 'new-password-12ch');

      expect(repo.updatePasswordHash).toHaveBeenCalledTimes(1);
      const [id, newHash] = repo.updatePasswordHash.mock.calls[0] as [string, string];
      expect(id).toBe(sampleUser.id);
      expect(await argon2.verify(newHash, 'new-password-12ch')).toBe(true);
    });

    it('rejects a wrong current password with 400 and leaves the hash untouched', async () => {
      const currentHash = await argon2.hash('old-password-12ch', { type: argon2.argon2id });
      repo.findById.mockResolvedValue({ ...sampleUser, passwordHash: currentHash });

      await expect(
        service.changePassword(sampleUser.id, 'wrong-password-12', 'new-password-12ch'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.updatePasswordHash).not.toHaveBeenCalled();
    });

    it('404s for an unknown user', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(
        service.changePassword('missing', 'irrelevant', 'new-password-12ch'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('resetPassword (P1.4)', () => {
    it('overwrites the credential and returns the one-time password once', async () => {
      repo.findById.mockResolvedValue(sampleUser);

      const { initialPassword } = await service.resetPassword(sampleUser.id);

      expect(initialPassword).toMatch(/^[\w-]{18}$/);
      const [id, newHash] = repo.updatePasswordHash.mock.calls[0] as [string, string];
      expect(id).toBe(sampleUser.id);
      expect(await argon2.verify(newHash, initialPassword)).toBe(true);
    });

    it('404s for an unknown user without touching the credential', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.resetPassword('missing')).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.updatePasswordHash).not.toHaveBeenCalled();
    });
  });
});
