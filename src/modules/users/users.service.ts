import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { generateInitialPassword } from '../../common/security/initial-password';
import type { User } from '../../infrastructure/database/schema/users.schema';
import type { CreateUserInput } from './dto/create-user.dto';
import type { UpdateUserInput } from './dto/update-user.dto';
import type { CursorPage } from './users.repository';
import { UsersRepository } from './users.repository';

/**
 * argon2id parameters chosen per OWASP Password Storage Cheat Sheet
 * (memoryCost ≥ 19 MiB, timeCost 2, parallelism 1) — see Pilar 4.
 * Re-tune when migrating to faster / slower hardware so a single hash
 * lands in the 250–500 ms range under load.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly repo: UsersRepository) {}

  async create(input: CreateUserInput): Promise<User> {
    const existing = await this.repo.findByEmail(input.email);
    if (existing) {
      // 409 instead of 400 — the request is well-formed, the conflict
      // is with stored state. See Pilar 2.
      throw new ConflictException('email already in use');
    }

    const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS);
    const user = await this.repo.create({
      email: input.email,
      fullName: input.fullName,
      passwordHash,
      role: input.role,
    });
    this.logger.log({ userId: user.id, role: user.role }, 'user created');
    return user;
  }

  /** Total users incl. soft-deleted — the first-run bootstrap gate. */
  count(): Promise<number> {
    return this.repo.countAll();
  }

  /**
   * First-run bootstrap: create the very first admin, but ONLY if the table
   * is empty. Role is forced to 'admin' server-side (never client-supplied).
   * Returns null when a user already exists (the caller maps that to 409).
   * The empty-check + insert are serialized by an advisory lock in the repo.
   */
  async bootstrapAdmin(input: {
    email: string;
    fullName: string;
    password: string;
  }): Promise<User | null> {
    const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS);
    const user = await this.repo.createIfEmpty({
      email: input.email,
      fullName: input.fullName,
      passwordHash,
      role: 'admin',
    });
    if (user) {
      this.logger.log({ userId: user.id }, 'bootstrap admin created');
    }
    return user;
  }

  async findById(id: string): Promise<User> {
    const user = await this.repo.findById(id);
    if (!user) throw new NotFoundException('user not found');
    return user;
  }

  async list(cursor: string | undefined, limit: number): Promise<CursorPage<User>> {
    return this.repo.listPage(cursor, limit);
  }

  async update(id: string, input: UpdateUserInput): Promise<User> {
    const user = await this.repo.update(id, input);
    this.logger.log({ userId: user.id, role: user.role }, 'user updated');
    return user;
  }

  async softDelete(id: string): Promise<void> {
    await this.repo.softDelete(id);
  }

  /**
   * Self-service credential rotation (P1.4). The current password is
   * re-verified even under a valid JWT so a hijacked session cannot
   * lock the owner out. 400 (not 401) on a wrong current password — the
   * session itself is authenticated; the input is what's wrong.
   */
  async changePassword(id: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.findById(id);
    const ok = await argon2.verify(user.passwordHash, currentPassword);
    if (!ok) throw new BadRequestException('current password is incorrect');

    const passwordHash = await argon2.hash(newPassword, ARGON2_OPTIONS);
    await this.repo.updatePasswordHash(id, passwordHash);
    this.logger.log({ userId: id }, 'password changed');
  }

  /**
   * Admin-issued reset (P1.4): overwrite the credential with a fresh
   * one-time password, returned exactly once to the caller for handoff.
   * The holder rotates it via changePassword. A set-password token link
   * replaces this handoff once P2 notifications exist.
   */
  async resetPassword(id: string): Promise<{ initialPassword: string }> {
    const user = await this.findById(id);
    const initialPassword = generateInitialPassword();
    const passwordHash = await argon2.hash(initialPassword, ARGON2_OPTIONS);
    await this.repo.updatePasswordHash(user.id, passwordHash);
    this.logger.log({ userId: id }, 'password reset by admin');
    return { initialPassword };
  }
}
