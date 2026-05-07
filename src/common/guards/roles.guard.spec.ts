import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../decorators/current-user.decorator';
import { RolesGuard } from './roles.guard';

function fakeContext(user: Partial<AuthUser> | null): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  it('returns true when no @Roles decorator is set', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(undefined),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(fakeContext({ id: '1', email: 'a@b', role: 'customer' }))).toBe(true);
  });

  it('returns true when the user role matches', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(['admin', 'staff']),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(fakeContext({ id: '1', email: 'a@b', role: 'admin' }))).toBe(true);
  });

  it('throws Forbidden when the user role does not match', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(['admin']),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() =>
      guard.canActivate(fakeContext({ id: '1', email: 'a@b', role: 'customer' })),
    ).toThrow(ForbiddenException);
  });

  it('throws Forbidden when there is no authenticated user', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(['admin']),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(fakeContext(null))).toThrow(ForbiddenException);
  });
});
