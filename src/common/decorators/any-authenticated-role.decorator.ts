import { SetMetadata } from '@nestjs/common';

export const ANY_AUTHENTICATED_ROLE_KEY = 'anyAuthenticatedRole';

/**
 * Explicit opt-out of RolesGuard's role check: any authenticated user
 * (any role, including `customer`) may call this handler. Still
 * requires a valid JWT — only the *role* restriction is waived, unlike
 * `@Public()` which waives authentication entirely.
 *
 * RolesGuard already treats "no `@Roles(...)` at all" as unrestricted
 * (see its doc comment) — this decorator does not change that
 * behavior. What it adds is auditability: the route-guardrail test
 * (`test/route-guards.e2e-spec.ts`) requires every handler to carry
 * `@Public()`, `@Roles(...)`, or this decorator, so "someone forgot
 * `@Roles`" is distinguishable from "someone deliberately decided any
 * authenticated role is fine". Prefer this over leaving a handler with
 * no access decorator at all.
 */
export const AnyAuthenticatedRole = () => SetMetadata(ANY_AUTHENTICATED_ROLE_KEY, true);
