/**
 * Pure, stable synthesis helpers for derived PPPoE session data.
 *
 * Because sessions are not persisted — they are derived 1:1 from each enabled
 * secret — we synthesise plausible address/uptime/callerId deterministically
 * from the secret's UUID so the values remain stable across pages and between
 * the secrets list (inline connection fields) and the sessions list.
 *
 * Algorithm: hash the secret id string into a stable integer, then derive
 * the per-session fields from that integer.
 */

/** Derive a stable unsigned integer in [0, 2^32) from a secret id string. */
function stableHash(id: string): number {
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    // Multiply by FNV prime 0x01000193, keeping 32-bit unsigned.
    h = Math.imul(h, 0x01000193);
  }
  // Ensure unsigned.
  return h >>> 0;
}

export interface DerivedConnection {
  /** Synthesised assigned IP in the CGNAT 100.64.0.0/10 range. */
  address: string;
  /** Synthesised uptime string, e.g. "3h42m". */
  uptime: string;
  /** Synthesised caller-id MAC address. */
  callerId: string;
}

/**
 * Returns stable synthetic connection info for a secret that is currently
 * online (!disabled). Must NOT be called for disabled secrets.
 *
 * The same secret id always yields the same address/uptime/callerId,
 * regardless of list position or page number.
 */
export function deriveConnection(secretId: string): DerivedConnection {
  const h = stableHash(secretId);

  // 100.64.x.y — CGNAT block (RFC 6598). Use bits of h for x and y.
  // x: 0–63, y: 2–253 (avoid .0, .1, .254, .255 for realism).
  const x = h & 0x3f; // 6 bits → 0-63
  const y = 2 + ((h >>> 6) % 252); // next 8 bits → 2-253
  const address = `100.64.${x}.${y}`;

  // Uptime: 0–23 hours, 0–59 minutes.
  const hours = (h >>> 14) % 24;
  const minutes = (h >>> 19) % 60;
  const uptime = `${hours}h${String(minutes).padStart(2, '0')}m`;

  // Caller-id MAC: AA:BB:xx:xx:xx:xx derived from the hash.
  const b = (shift: number) => ((h >>> shift) & 0xff).toString(16).padStart(2, '0').toUpperCase();
  const callerId = `AA:BB:${b(0)}:${b(8)}:${b(16)}:${b(24)}`;

  return { address, uptime, callerId };
}
