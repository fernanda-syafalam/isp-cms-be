import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { PinoLogger } from 'nestjs-pino';
import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AuditInterceptor } from './audit.interceptor';

function fakeContext(opts: { user?: { id: string }; params?: unknown }): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user: opts.user, params: opts.params ?? {} }),
    }),
  } as unknown as ExecutionContext;
}

function makeLogger(): {
  logger: PinoLogger;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  setContext: ReturnType<typeof vi.fn>;
} {
  const info = vi.fn();
  const warn = vi.fn();
  const setContext = vi.fn();
  return {
    logger: { info, warn, setContext } as unknown as PinoLogger,
    info,
    warn,
    setContext,
  };
}

describe('AuditInterceptor', () => {
  it('passes through without logging when @Audit is not set', async () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(undefined),
    } as unknown as Reflector;
    const { logger, info, warn } = makeLogger();
    const interceptor = new AuditInterceptor(reflector, logger);
    const next: CallHandler = { handle: () => of('ok') };

    await expect(lastValueFrom(interceptor.intercept(fakeContext({}), next))).resolves.toBe('ok');
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('emits an audit success log when the handler resolves', async () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue('user.soft_delete'),
    } as unknown as Reflector;
    const { logger, info } = makeLogger();
    const interceptor = new AuditInterceptor(reflector, logger);
    const next: CallHandler = { handle: () => of(undefined) };

    await lastValueFrom(
      interceptor.intercept(fakeContext({ user: { id: 'u-1' }, params: { id: 't-1' } }), next),
    );

    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: true,
        action: 'user.soft_delete',
        actor: 'u-1',
        target: { id: 't-1' },
        outcome: 'success',
      }),
      'audit event',
    );
  });

  it('emits an audit failure log with the error message when the handler throws', async () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue('user.soft_delete'),
    } as unknown as Reflector;
    const { logger, warn } = makeLogger();
    const interceptor = new AuditInterceptor(reflector, logger);
    const next: CallHandler = {
      handle: () => throwError(() => new Error('boom')),
    };

    await expect(
      lastValueFrom(interceptor.intercept(fakeContext({ user: { id: 'u-1' } }), next)),
    ).rejects.toThrow('boom');

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: true,
        action: 'user.soft_delete',
        actor: 'u-1',
        outcome: 'failure',
        err: 'boom',
      }),
      'audit event',
    );
  });
});
