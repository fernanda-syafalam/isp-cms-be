import { randomBytes } from 'node:crypto';

/**
 * One-time initial password for a staff-communicated credential handoff
 * (onboarding portal login, admin password reset). 18 base64url chars
 * (~108 bits) — comfortably over the 12-char CreateUserSchema minimum.
 * Always surfaced exactly once in the API response and never persisted
 * in plaintext; the holder rotates it via POST /v1/auth/change-password.
 */
export function generateInitialPassword(): string {
  return randomBytes(13).toString('base64url').slice(0, 18);
}
