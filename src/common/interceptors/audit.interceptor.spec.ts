import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { PinoLogger } from 'nestjs-pino';
import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { AuditRepository } from '../../modules/audit/audit.repository';
import type { AuditMeta } from '../decorators/audit.decorator';
import { AuditInterceptor } from './audit.interceptor';

function fakeContext(opts: {
  user?: { id: string; email?: string };
  params?: unknown;
}): ExecutionContext {
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

function makeRepo(record: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)): {
  repo: AuditRepository;
  record: ReturnType<typeof vi.fn>;
} {
  return { repo: { record } as unknown as AuditRepository, record };
}

function reflectorReturning(meta: AuditMeta | undefined): Reflector {
  return { getAllAndOverride: vi.fn().mockReturnValue(meta) } as unknown as Reflector;
}

// Let the fire-and-forget persist (and its .catch) settle before asserting.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('AuditInterceptor', () => {
  it('passes through without logging or persisting when @Audit is not set', async () => {
    const { logger, info, warn } = makeLogger();
    const { repo, record } = makeRepo();
    const interceptor = new AuditInterceptor(reflectorReturning(undefined), logger, repo);
    const next: CallHandler = { handle: () => of('ok') };

    await expect(lastValueFrom(interceptor.intercept(fakeContext({}), next))).resolves.toBe('ok');
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('emits a success log and persists a row when the handler resolves', async () => {
    const { logger, info } = makeLogger();
    const { repo, record } = makeRepo();
    const interceptor = new AuditInterceptor(
      reflectorReturning({ action: 'user.soft_delete' }),
      logger,
      repo,
    );
    const next: CallHandler = { handle: () => of(undefined) };

    await lastValueFrom(
      interceptor.intercept(
        fakeContext({ user: { id: 'u-1', email: 'a@x.io' }, params: { id: 't-1' } }),
        next,
      ),
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
    // Persisted row derives actor from email, entity from the action prefix.
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({
      actor: 'a@x.io',
      action: 'user.soft_delete',
      entity: 'user',
      summary: 'user.soft_delete #t-1',
      entityId: 't-1',
    });
  });

  it('uses the decorator-provided entity and falls back to "system" actor', async () => {
    const { logger } = makeLogger();
    const { repo, record } = makeRepo();
    const interceptor = new AuditInterceptor(
      reflectorReturning({ action: 'auth.login', entity: 'session' }),
      logger,
      repo,
    );
    const next: CallHandler = { handle: () => of(undefined) };

    await lastValueFrom(interceptor.intercept(fakeContext({}), next));

    expect(record).toHaveBeenCalledWith({
      actor: 'system',
      action: 'auth.login',
      entity: 'session',
      summary: 'auth.login',
      entityId: undefined,
    });
  });

  it('does not persist when the handler throws', async () => {
    const { logger, warn } = makeLogger();
    const { repo, record } = makeRepo();
    const interceptor = new AuditInterceptor(
      reflectorReturning({ action: 'user.soft_delete' }),
      logger,
      repo,
    );
    const next: CallHandler = { handle: () => throwError(() => new Error('boom')) };

    await expect(
      lastValueFrom(interceptor.intercept(fakeContext({ user: { id: 'u-1' } }), next)),
    ).rejects.toThrow('boom');

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ audit: true, action: 'user.soft_delete', outcome: 'failure' }),
      'audit event',
    );
    expect(record).not.toHaveBeenCalled();
  });

  it('still resolves the request and warns when persistence fails', async () => {
    const { logger, warn } = makeLogger();
    const { repo, record } = makeRepo(vi.fn().mockRejectedValue(new Error('db down')));
    const interceptor = new AuditInterceptor(
      reflectorReturning({ action: 'user.soft_delete' }),
      logger,
      repo,
    );
    const next: CallHandler = { handle: () => of('ok') };

    await expect(
      lastValueFrom(interceptor.intercept(fakeContext({ user: { id: 'u-1' } }), next)),
    ).resolves.toBe('ok');

    await flush();
    expect(record).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ audit: true, err: expect.stringContaining('db down') }),
      'audit persist failed',
    );
  });
});
