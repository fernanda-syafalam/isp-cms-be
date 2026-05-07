import { SetMetadata } from '@nestjs/common';
import type { AuthUser } from './current-user.decorator';

export const ROLES_KEY = 'roles';

/**
 * Coarse-grained RBAC marker. Apply to a handler (or a controller
 * class) to require that the JWT'd user has one of the listed roles.
 * Resource ownership ("only the owner of order X can read it") stays
 * in the service — guards do not have domain knowledge. See Pilar 4.
 */
export const Roles = (...roles: AuthUser['role'][]) => SetMetadata(ROLES_KEY, roles);
