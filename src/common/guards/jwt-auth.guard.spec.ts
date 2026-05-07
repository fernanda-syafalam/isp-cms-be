import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from './jwt-auth.guard';

function fakeContext(): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({}) }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  it('short-circuits to true on a public handler without invoking Passport', () => {
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(true) } as unknown as Reflector;
    const guard = new JwtAuthGuard(reflector);
    const superSpy = vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate');

    expect(guard.canActivate(fakeContext())).toBe(true);
    expect(superSpy).not.toHaveBeenCalled();
  });

  it('delegates to the JWT strategy when the route is not marked public', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(undefined),
    } as unknown as Reflector;
    const guard = new JwtAuthGuard(reflector);
    const superSpy = vi
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockReturnValue(true);

    expect(guard.canActivate(fakeContext())).toBe(true);
    expect(superSpy).toHaveBeenCalledTimes(1);
  });
});
