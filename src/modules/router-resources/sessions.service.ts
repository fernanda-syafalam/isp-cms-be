import { Injectable, NotFoundException } from '@nestjs/common';
import { RoutersRepository } from '../routers/routers.repository';
import type { SessionResponse } from './dto/session.dto';
import { SecretsRepository } from './secrets.repository';

/**
 * Online PPPoE sessions are derived from enabled secrets (1:1) — the live
 * device owns the real session table, so there is nothing to persist here.
 * Address / uptime / caller-id are synthesised deterministically per secret.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly secrets: SecretsRepository,
    private readonly routers: RoutersRepository,
  ) {}

  async list(routerId: string): Promise<{ items: SessionResponse[]; total: number }> {
    await this.requireRouter(routerId);
    const { items } = await this.secrets.listByRouter(routerId);
    const sessions = items
      .filter((s) => !s.disabled)
      .map((s, i) => ({
        id: s.id,
        routerId,
        username: s.username,
        address: `100.64.0.${2 + (i % 250)}`,
        uptime: `${1 + (i % 23)}h${(i * 7) % 60}m`,
        callerId: macFromIndex(i),
      }));
    return { items: sessions, total: sessions.length };
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

function macFromIndex(i: number): string {
  const b = (n: number) => ((i * 17 + n * 31) % 256).toString(16).padStart(2, '0').toUpperCase();
  return `AA:BB:${b(1)}:${b(2)}:${b(3)}:${b(4)}`;
}
