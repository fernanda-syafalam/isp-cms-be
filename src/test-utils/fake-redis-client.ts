import { vi } from 'vitest';

/**
 * A minimal in-memory ioredis stand-in shared by every spec that boots
 * `AuthModule`/`SecurityModule` (real `RefreshTokenService`) without a real
 * Redis. Implements exactly the commands `RefreshTokenService`,
 * `TotpLockoutService`, and `TotpReplayGuardService` issue: string
 * get/set/getdel/del/incr/expire, set sadd/srem/smembers, and the three
 * `eval` Lua scripts (`RefreshTokenService`'s atomic revoke / atomic
 * rotate-commit, and `TotpReplayGuardService`'s atomic accept-step — see
 * each file's doc comments for exactly what its script does) —
 * reimplemented here in JS against the same in-memory maps so the fake
 * behaves like a single Redis instance actually would (including the
 * atomicity: this factory's `eval` mutates the shared maps synchronously,
 * so from the point of view of `await`ing callers there is no window for
 * another operation to interleave mid-script, matching real Redis's
 * guarantee).
 *
 * Dispatch inside `eval` is by `numkeys` (1 = the TOTP accept-step
 * script, 2 = the revoke script, 3 = the rotate-commit script) rather
 * than by matching the script source, so this fake does not need to know
 * the exact Lua text — only the KEYS/ARGV shape each caller uses.
 */
export function createFakeRedisClient() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();

  return {
    call: vi.fn(async () => null),
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK' as const;
    }),
    getdel: vi.fn(async (k: string) => {
      const v = store.get(k);
      if (v === undefined) return null;
      store.delete(k);
      return v;
    }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    sadd: vi.fn(async (k: string, ...members: string[]) => {
      const set = sets.get(k) ?? new Set<string>();
      for (const m of members) set.add(m);
      sets.set(k, set);
      return members.length;
    }),
    srem: vi.fn(async (k: string, ...members: string[]) => {
      const set = sets.get(k);
      if (!set) return 0;
      let removed = 0;
      for (const m of members) if (set.delete(m)) removed++;
      return removed;
    }),
    smembers: vi.fn(async (k: string) => [...(sets.get(k) ?? [])]),
    // TotpLockoutService (F1) — per-user failed-attempt counter.
    incr: vi.fn(async (k: string) => {
      const v = Number(store.get(k) ?? '0') + 1;
      store.set(k, String(v));
      return v;
    }),
    expire: vi.fn(async () => 1),
    eval: vi.fn(async (_script: string, numkeys: number, ...rest: Array<string | number>) => {
      const keys = rest.slice(0, numkeys).map(String);
      const args = rest.slice(numkeys).map(String);

      if (numkeys === 1) {
        // TOTP accept-step script (TotpReplayGuardService) — KEYS = [key],
        // ARGV = [step, ttlSeconds]. Reject (0) when a step already
        // recorded is >= the new one (replay/stale); otherwise record it
        // and accept (1).
        const [key] = keys as [string];
        const [stepStr] = args as [string, string];
        const last = store.get(key);
        if (last !== undefined && Number(last) >= Number(stepStr)) {
          return 0;
        }
        store.set(key, stepStr);
        return 1;
      }

      if (numkeys === 2) {
        // Revoke script — KEYS = [sessionKey, indexKey], ARGV = [sessionId].
        const [sessionKey, indexKey] = keys as [string, string];
        const [sessionId] = args as [string];
        const raw = store.get(sessionKey);
        if (!raw) {
          sets.get(indexKey)?.delete(sessionId);
          return 0;
        }
        const record = JSON.parse(raw) as { refreshKey: string };
        store.delete(record.refreshKey);
        store.delete(sessionKey);
        sets.get(indexKey)?.delete(sessionId);
        return 1;
      }

      // Rotate-commit script — KEYS = [newRefreshKey, indexKey, sessionKey],
      // ARGV = [requireExisting, sessionId, tokenPayloadJson, ttl, recordJson].
      const [newRefreshKey, indexKey, sessionKey] = keys as [string, string, string];
      const [requireExisting, sessionId, tokenJson, , recordJson] = args as [
        string,
        string,
        string,
        string,
        string,
      ];
      if (requireExisting === '1') {
        const isMember = sets.get(indexKey)?.has(sessionId) ?? false;
        if (!isMember) return 0;
      }
      store.set(newRefreshKey, tokenJson);
      store.set(sessionKey, recordJson);
      const set = sets.get(indexKey) ?? new Set<string>();
      set.add(sessionId);
      sets.set(indexKey, set);
      return 1;
    }),
    _store: store,
    _sets: sets,
  };
}
