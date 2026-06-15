import { Injectable } from '@nestjs/common';
import type { OdpRecordRow } from '../../infrastructure/database/schema/odp.schema';
import type { OdpListResponse, OdpRecordResponse } from './dto/odp-response.dto';
import { buildOdpFixture } from './odp.fixtures';
import { OdpRepository } from './odp.repository';

/**
 * Read-only ODP capacity dashboard. Self-seeds its fixture on first access
 * (mock-first island, ADR-0003) — separate from the topology node forest.
 */
@Injectable()
export class OdpService {
  constructor(private readonly repo: OdpRepository) {}

  async list(): Promise<OdpListResponse> {
    await this.repo.ensureSeeded(buildOdpFixture());
    const items = (await this.repo.list()).map(toOdpResponse);
    return { items, total: items.length };
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
