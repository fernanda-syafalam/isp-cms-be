import { ConflictException, Injectable } from '@nestjs/common';
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

  /**
   * Reserve one port for a new subscriber's drop, called from onboarding
   * before the customer row is created. The repo's guarded UPDATE is the
   * concurrency gate; a null result means the ODP is full or does not
   * exist, either of which is a 409 to the caller (never a generic Error).
   */
  async assignPort(odpId: string): Promise<OdpRecordRow> {
    const row = await this.repo.assignPort(odpId);
    if (!row) throw new ConflictException('ODP penuh atau tidak ditemukan');
    return row;
  }

  /** Release one port (relocate/churn off this ODP). No-op (returns null) when already at 0 or missing. */
  async releasePort(odpId: string): Promise<OdpRecordRow | null> {
    return this.repo.releasePort(odpId);
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
