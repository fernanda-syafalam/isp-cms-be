import { PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, Reflector } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { ANY_AUTHENTICATED_ROLE_KEY } from '../src/common/decorators/any-authenticated-role.decorator';
import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';

/**
 * Guardrail for a P0-class regression class: `JwtAuthGuard` is
 * default-DENY (JWT required unless `@Public()`), but `RolesGuard` is
 * default-ALLOW (a no-op unless `@Roles(...)` is present — see its doc
 * comment). A new authenticated endpoint that forgets `@Roles(...)` is
 * therefore silently reachable by ANY authenticated role, including
 * `customer`.
 *
 * This test enumerates every HTTP route handler wired into AppModule
 * and asserts each one carries `@Public()`, `@Roles(...)`, or
 * `@AnyAuthenticatedRole()` metadata, checked at the handler first and
 * falling back to the controller class — the exact same lookup
 * (`reflector.getAllAndOverride(key, [handler, class])`) that
 * JwtAuthGuard and RolesGuard themselves use at request time.
 *
 * `@AnyAuthenticatedRole()` is a pure documentation/audit marker (see
 * its own doc comment) for handlers where RolesGuard's default-allow
 * is a deliberate choice, not an oversight — e.g. `GET /v1/settings/public`
 * (any signed-in user needs the company/tax subset for invoices — the
 * full `GET /v1/settings` blob, including billing policy, is
 * `@Roles('admin')`) or `POST /v1/auth/change-password` (self-service,
 * any role). It does
 * NOT relax any guard — it only lets this test distinguish "reviewed,
 * intentionally unrestricted" from "forgot to add @Roles". If a future
 * handler is genuinely neither, this test fails and lists it — do not
 * silence it by adding a decorator here; annotate the real handler in
 * its own module instead, and only add `@AnyAuthenticatedRole()` when
 * that really is the intended access policy.
 *
 * Deliberately does NOT create a Nest application / call `app.init()`
 * or `listen()` — DiscoveryService only needs the compiled DI graph
 * (`TestingModule.compile()`), so no real DB/Redis connection is
 * attempted and no HTTP server is started. Lighter and less flaky than
 * a full e2e boot for a purely static metadata check.
 */
describe('Route guardrail: every handler has an explicit access policy (e2e)', () => {
  let moduleRef: TestingModule;
  let discovery: DiscoveryService;
  let reflector: Reflector;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule, DiscoveryModule],
    }).compile();
    discovery = moduleRef.get(DiscoveryService);
    reflector = moduleRef.get(Reflector);
  }, 30_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  it('has no un-guarded route handler', () => {
    const unguarded: string[] = [];

    for (const wrapper of discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      // Cast away the DiscoveryService-supplied `any` at the boundary
      // instead of threading it further — the prototype's own shape is
      // irrelevant here, only each member's reflected metadata matters.
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;

      for (const methodName of Object.getOwnPropertyNames(prototype)) {
        if (methodName === 'constructor') continue;
        const handler = prototype[methodName];
        if (typeof handler !== 'function') continue;
        // Only actual route handlers carry Nest's PATH_METADATA (set by
        // @Get/@Post/etc.) — plain private helper methods on the
        // controller do not and must be skipped.
        if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;

        const isPublic = reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, metatype]);
        const roles = reflector.getAllAndOverride<string[]>(ROLES_KEY, [handler, metatype]);
        const isAnyAuthenticatedRole = reflector.getAllAndOverride<boolean>(
          ANY_AUTHENTICATED_ROLE_KEY,
          [handler, metatype],
        );

        if (!isPublic && !roles?.length && !isAnyAuthenticatedRole) {
          const path: string | string[] = Reflect.getMetadata(PATH_METADATA, handler);
          unguarded.push(`${metatype.name}.${methodName} (path: ${path || '/'})`);
        }
      }
    }

    expect(
      unguarded,
      `Un-guarded route handler(s) found — annotate with @Public(), @Roles(...), or @AnyAuthenticatedRole() (only if that is truly the intended policy):\n${unguarded.join('\n')}`,
    ).toEqual([]);
  });
});
