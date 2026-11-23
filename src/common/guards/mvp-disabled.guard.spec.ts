import { type ExecutionContext, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { MvpDisabledGuard } from './mvp-disabled.guard';

function fakeContext(method: string, url: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, url }) }),
  } as unknown as ExecutionContext;
}

describe('MvpDisabledGuard', () => {
  it('throws NotFoundException with the unknown-route message', () => {
    const guard = new MvpDisabledGuard();
    const ctx = fakeContext('POST', '/v1/x/suspend');
    expect(() => guard.canActivate(ctx)).toThrow(NotFoundException);
    expect(() => guard.canActivate(ctx)).toThrow('Cannot POST /v1/x/suspend');
  });
});
