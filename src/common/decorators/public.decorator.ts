import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opt-out marker for the global JwtAuthGuard. Apply to controller
 * classes (e.g. HealthController) or specific handlers (e.g. login)
 * that should be reachable without an Authorization header.
 *
 * Default-deny is the policy — see Pilar 4.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
