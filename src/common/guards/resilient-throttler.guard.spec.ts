import { ThrottlerException } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';
import { describe, expect, it, vi } from 'vitest';
import { ResilientThrottlerGuard } from './resilient-throttler.guard';

// ThrottlerGuard needs (options, storage, reflector). Dummies are fine
// because every test spies on super.handleRequest and never runs it.
function makeGuard(): ResilientThrottlerGuard {
  return new ResilientThrottlerGuard(
    { throttlers: [{ ttl: 60_000, limit: 100 }] } as never,
    {} as never,
    {} as never,
  );
}

// handleRequest is protected; expose it for the test without `any`.
function callHandleRequest(guard: ResilientThrottlerGuard): Promise<boolean> {
  return (
    guard as unknown as { handleRequest(r: ThrottlerRequest): Promise<boolean> }
  ).handleRequest({} as ThrottlerRequest);
}

function spyOnSuperHandleRequest(guard: ResilientThrottlerGuard) {
  const superProto = Object.getPrototypeOf(Object.getPrototypeOf(guard));
  return vi.spyOn(superProto, 'handleRequest');
}

describe('ResilientThrottlerGuard', () => {
  it('fails open (allows the request) when the storage backend errors', async () => {
    const guard = makeGuard();
    spyOnSuperHandleRequest(guard).mockRejectedValue(
      new Error('connect ECONNREFUSED 127.0.0.1:6379'),
    );

    await expect(callHandleRequest(guard)).resolves.toBe(true);
  });

  it('re-throws a genuine rate-limit hit so 429 is still enforced', async () => {
    const guard = makeGuard();
    spyOnSuperHandleRequest(guard).mockRejectedValue(new ThrottlerException());

    await expect(callHandleRequest(guard)).rejects.toBeInstanceOf(ThrottlerException);
  });

  it('passes through the normal allow decision when storage is healthy', async () => {
    const guard = makeGuard();
    spyOnSuperHandleRequest(guard).mockResolvedValue(true);

    await expect(callHandleRequest(guard)).resolves.toBe(true);
  });
});
