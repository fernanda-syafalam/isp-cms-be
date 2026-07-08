/**
 * Network-enforcement seam for the billing lifecycle (P2.5, ADR-0008). Isolir
 * and reactivation flip a PPPoE secret's `disabled` flag; in `live` mode that
 * flag must also reach the real RouterOS device so the session is actually cut
 * / restored, not only recorded in the DB.
 *
 * The DB write remains the source of truth (and the `simulation` mode's only
 * effect). Implementations push the intended state to the device best-effort —
 * a caller never blocks its billing run on a momentarily-unreachable router.
 */

/** One router's API connection + the secret to toggle on it. */
export type RouterSecretTarget = {
  host: string;
  apiPort: number;
  /**
   * RouterOS API login user, already resolved (the router's `apiUsername`
   * override, falling back to its `username` — see routers.schema.ts).
   */
  routerUser: string;
  /**
   * SEC-M1: the router's own AES-256-GCM-encrypted API password
   * (`iv:authTag:ciphertext`), or `null` when this router has no
   * per-router credential set yet. The live adapter decrypts it and, only
   * when `null`, falls back to the shared env `ROUTEROS_API_PASSWORD`
   * (logging a warning). Never the plaintext — decryption happens in the
   * adapter, the only place that also holds the cipher key.
   */
  apiPasswordEncrypted: string | null;
  /** The PPPoE secret's username (=name on the device). */
  secretUsername: string;
};

// Abstract class (not a bare interface) so it can be a Nest DI token.
export abstract class RouterAdapter {
  /**
   * Enable/disable one PPPoE secret on its router. Must not throw for a
   * transient device failure in a way that aborts the caller's batch — the
   * live implementation logs and swallows per-target errors (the DB already
   * holds the intended state for a later reconcile).
   */
  abstract setSecretDisabled(target: RouterSecretTarget, disabled: boolean): Promise<void>;
}
