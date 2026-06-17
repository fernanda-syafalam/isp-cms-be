import { Injectable } from '@nestjs/common';
import type { OdpRecordRow } from '../../infrastructure/database/schema/odp.schema';
import type { OdpListResponse, OdpRecordResponse } from './dto/odp-response.dto';
import { buildOdpFixture } from './odp.fixtures';
import { type OdpListFilter, OdpRepository } from './odp.repository';

/**
 * Read-only ODP capacity dashboard. Self-seeds its fixture on first access
 * (mock-first island, ADR-0003) — separate from the topology node forest.
 */
@Injectable()
export class OdpService {
  constructor(private readonly repo: OdpRepository) {}

  async list(filter: OdpListFilter): Promise<OdpListResponse> {
    await this.repo.ensureSeeded(buildOdpFixture());
    const { items, total, summary } = await this.repo.list(filter);
    return { items: items.map(toOdpResponse), total, summary };
  }
}

function toOdpResponse(row: OdpRecordRow): OdpRecordResponse {
  return {
    id: row.id,
    name: row.name,
    area: row.area,
    splitter: row.splitter,
    totalPorts: row.totalPorts,
    usedPorts: row.usedPorts,
    avgRxPowerDbm: row.avgRxPowerDbm,
    status: row.status,
  };
}
