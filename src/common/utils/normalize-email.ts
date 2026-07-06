/**
 * Canonical form for an email used as an identity key (users.email):
 * trims surrounding whitespace and lowercases the whole string.
 *
 * Applied on WRITE (users.service create / bootstrapAdmin) so new rows
 * are always stored lowercased, and on READ (users.repository
 * findByEmail) so a lookup is case-insensitive regardless of how the
 * caller typed it. The two sides must stay in sync: a plain `eq()`
 * against the stored column only works if both sides are normalized
 * the same way.
 *
 * Distinct from `customers`' local `normalizeEmail` (empty string → null
 * for an optional contact field) — users.email is a required identity
 * column with different semantics, so the two are not merged.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
