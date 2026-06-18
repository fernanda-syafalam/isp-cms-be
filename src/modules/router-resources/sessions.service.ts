import { Injectable, NotFoundException } from '@nestjs/common';
import { RoutersRepository } from '../routers/routers.repository';
import type { SessionResponse } from './dto/session.dto';
import { SecretsRepository } from './secrets.repository';
import { deriveConnection } from './session-synthesis';

export interface SessionListFilter {
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

// Sort keys the frontend may use for sessions (camelCase). Uptime is excluded
// because it is a human string ("3h42m") and lexicographic order is wrong.
const SESSION_SORT_KEYS = ['username', 'address', 'customerName', 'profileName'] as const;
type SessionSortKey = (typeof SESSION_SORT_KEYS)[number];

function isSessionSortKey(k: string): k is SessionSortKey {
  return (SESSION_SORT_KEYS as readonly string[]).includes(k);
}

/**
 * Online PPPoE sessions are derived from enabled secrets (1:1) — the live
 * device owns the real session table, so there is nothing to persist here.
 * Address / uptime / caller-id are synthesised deterministically per secret
 * using a stable hash so values do not change across pages.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly secrets: SecretsRepository,
    private readonly routers: RoutersRepository,
  ) {}

  async list(
    routerId: string,
    filter: SessionListFilter,
  ): Promise<{ items: SessionResponse[]; total: number }> {
    await this.requireRouter(routerId);

    // Fetch all enabled secrets for the router — session count per router is
    // small (hundreds), so in-memory pagination is fine here.
    const { items: allSecrets } = await this.secrets.listByRouter(routerId);
    const enabledSecrets = allSecrets.filter((s) => !s.disabled);

    // Synthesise sessions (stable per secret id, not per position).
    const allSessions: SessionResponse[] = enabledSecrets.map((s) => {
      const conn = deriveConnection(s.id);
      return {
        id: s.id,
        routerId,
        username: s.username,
        address: conn.address,
        uptime: conn.uptime,
        callerId: conn.callerId,
        // Denormalized from secret:
        customerId: s.customerId ?? null,
        customerName: s.customerName ?? null,
        profileName: s.profileName,
      };
    });

    // Apply q filter (case-insensitive substring over username, address, customerName).
    const q = filter.q?.toLowerCase();
    const filtered = q
      ? allSessions.filter(
          (sess) =>
            sess.username.toLowerCase().includes(q) ||
            sess.address.toLowerCase().includes(q) ||
            (sess.customerName?.toLowerCase().includes(q) ?? false),
        )
      : allSessions;

    // Apply sort.
    const sortKey = filter.sort && isSessionSortKey(filter.sort) ? filter.sort : 'username';
    const dir = filter.order === 'desc' ? -1 : 1;
    const sorted = [...filtered].sort((a, b) => {
      const av = (a[sortKey] ?? '').toString().toLowerCase();
      const bv = (b[sortKey] ?? '').toString().toLowerCase();
      return av < bv ? -dir : av > bv ? dir : 0;
    });

    const total = sorted.length;

    // Apply pagination.
    const page = sorted.slice(filter.offset, filter.offset + filter.limit);

    return { items: page, total };
  }

  // Best-effort disconnect — there is no persisted session to remove; the
  // real RouterOS would drop the PPPoE link. 404s on an unknown router.
  async disconnect(routerId: string): Promise<void> {
    await this.requireRouter(routerId);
  }

  private async requireRouter(routerId: string): Promise<void> {
    if (!(await this.routers.findById(routerId))) throw new NotFoundException('router not found');
  }
}
