import { describe, expect, it } from 'vitest';
import { CreateUserSchema } from './create-user.dto';
import { UpdateUserSchema } from './update-user.dto';

const base = { email: 'a@b.test', fullName: 'A', password: 'correct-horse-battery' };

describe('CreateUserSchema role', () => {
  it('requires a role (no default)', () => {
    expect(CreateUserSchema.safeParse(base).success).toBe(false);
  });

  it.each(['mitra', 'customer'])('rejects the disabled role %s', (role) => {
    expect(CreateUserSchema.safeParse({ ...base, role }).success).toBe(false);
  });

  it.each(['admin', 'staff', 'teknisi'])('accepts %s', (role) => {
    expect(CreateUserSchema.safeParse({ ...base, role }).success).toBe(true);
  });
});

describe('UpdateUserSchema role', () => {
  it('stays optional', () => {
    expect(UpdateUserSchema.safeParse({ fullName: 'B' }).success).toBe(true);
  });

  it.each(['mitra', 'customer'])('rejects the disabled role %s', (role) => {
    expect(UpdateUserSchema.safeParse({ role }).success).toBe(false);
  });

  it.each(['admin', 'staff', 'teknisi'])('accepts %s', (role) => {
    expect(UpdateUserSchema.safeParse({ role }).success).toBe(true);
  });
});
