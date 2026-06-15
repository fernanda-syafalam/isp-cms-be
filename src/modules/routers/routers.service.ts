import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Router } from '../../infrastructure/database/schema/routers.schema';
import type { ConnectRouterInput } from './dto/connect-router.dto';
import type { RouterResponse, TestConnectionResult } from './dto/router-response.dto';
import { type RouterListFilter, RoutersRepository } from './routers.repository';

// Synthesised RouterOS metadata until the real API integration lands. The
// pick is deterministic per host so a record's model/version is stable.
const MODELS = ['RB5009', 'CCR2004', 'RB4011', 'hAP ax3'] as const;
const VERSIONS = ['7.15.3', '7.14.2', '7.13.5', '6.49.13'] as const;

@Injectable()
export class RoutersService {
  private readonly logger = new Logger(RoutersService.name);

  constructor(private readonly repo: RoutersRepository) {}

  async list(filter: RouterListFilter): Promise<{ items: RouterResponse[]; total: number }> {
    const { items, total } = await this.repo.list(filter);
    return { items: items.map(toRouterResponse), total };
  }

  async findById(id: string): Promise<RouterResponse> {
    return toRouterResponse(await this.requireById(id));
  }

  /** Probe a device without persisting anything. */
  testConnection(input: ConnectRouterInput): TestConnectionResult {
    return {
      ok: true,
      identity: `MikroTik-${input.host}`,
      model: pick(MODELS, input.host, 'RB5009'),
      version: pick(VERSIONS, input.host, '7.15.3'),
      message: null,
    };
  }

  /** Save a new managed router (probes for model/version). */
  async connect(input: ConnectRouterInput): Promise<RouterResponse> {
    const router = await this.repo.create({
      name: input.name,
      address: input.host,
      apiPort: input.apiPort,
      username: input.username,
      model: pick(MODELS, input.host, 'RB5009'),
      version: pick(VERSIONS, input.host, '7.15.3'),
    });
    this.logger.log({ routerId: router.id }, 'router connected');
    return toRouterResponse(router);
  }

  async sync(id: string): Promise<RouterResponse> {
    const router = await this.repo.markSynced(id);
    this.logger.log({ routerId: id }, 'router synced');
    return toRouterResponse(router);
  }

  // reboot / test are no-ops against the stored record (no real device yet),
  // but they 404 on an unknown router so the UI behaves correctly.
  async reboot(id: string): Promise<RouterResponse> {
    return toRouterResponse(await this.requireById(id));
  }

  async test(id: string): Promise<RouterResponse> {
    return toRouterResponse(await this.requireById(id));
  }

  private async requireById(id: string): Promise<Router> {
    const router = await this.repo.findById(id);
    if (!router) throw new NotFoundException('router not found');
    return router;
  }
}

function pick<T>(arr: readonly T[], host: string, fallback: T): T {
  let h = 0;
  for (let i = 0; i < host.length; i += 1) {
    h = (h * 31 + host.charCodeAt(i)) >>> 0;
  }
  return arr[h % arr.length] ?? fallback;
}

function toRouterResponse(row: Router): RouterResponse {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    apiPort: row.apiPort,
    username: row.username,
    model: row.model,
    version: row.version,
    status: row.status,
    secretCount: row.secretCount,
    lastSyncAt: row.lastSyncAt.toISOString(),
  };
}
