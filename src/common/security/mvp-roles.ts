import { z } from 'zod';
import { userRole } from '../../infrastructure/database/schema/users.schema';

// MVP scope: these roles cannot log in, refresh or use a token, nor be assigned.
// Re-enabling a role is a one-line change here (drop it from this list).
export const MVP_DISABLED_ROLES = ['mitra', 'customer'] as const;

export type MvpDisabledRole = (typeof MVP_DISABLED_ROLES)[number];

export function isRoleDisabled(role: string): role is MvpDisabledRole {
  return (MVP_DISABLED_ROLES as readonly string[]).includes(role);
}

/** Every role in the DB enum except the MVP-disabled ones. */
export const AssignableRoleSchema = z.enum(userRole.enumValues).exclude([...MVP_DISABLED_ROLES]);
