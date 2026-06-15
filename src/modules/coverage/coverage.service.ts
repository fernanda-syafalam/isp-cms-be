import { Injectable } from '@nestjs/common';
import type {
  CoverageArea,
  NewCoverageArea,
} from '../../infrastructure/database/schema/coverage.schema';
import type { CoverageResponse } from './dto/coverage-response.dto';
import { type CoverageListFilter, CoverageRepository } from './coverage.repository';

const AREA_NAMES = [
  'Jepara',
  'Tahunan',
  'Pecangaan',
  'Kalinyamatan',
  'Mlonggo',
  'Bangsri',
  'Mayong',
  'Batealit',
];
const SEED_STATUS = ['operational', 'operational', 'maintenance', 'down'] as const;

// One POP/area per name, alternating type — seeded on first read.
const DEFAULTS: NewCoverageArea[] = AREA_NAMES.map((name, i) => ({
  name: i % 2 === 0 ? `POP ${name}` : `Area ${name}`,
  type: i % 2 === 0 ? 'pop' : 'area',
  region: 'Jawa Tengah',
  capacity: 500 + i * 100,
  activeConnections: 320 + i * 60,
  status: SEED_STATUS[i % SEED_STATUS.length] ?? 'operational',
}));

@Injectable()
export class CoverageService {
  constructor(private readonly repo: CoverageRepository) {}

  async list(filter: CoverageListFilter): Promise<{ items: CoverageResponse[]; total: number }> {
    await this.repo.ensureSeeded(DEFAULTS);
    const { items, total } = await this.repo.list(filter);
    return { items: items.map(toCoverageResponse), total };
  }
}

function toCoverageResponse(row: CoverageArea): CoverageResponse {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    region: row.region,
    capacity: row.capacity,
    activeConnections: row.activeConnections,
    status: row.status,
  };
}
