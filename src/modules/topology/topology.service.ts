import { Injectable } from '@nestjs/common';
import type {
  CableResponse,
  CircuitResponse,
  ClosureResponse,
  SpliceResponse,
  SplitterResponse,
  StrandResponse,
} from './dto/cabling-response.dto';
import type { TopologyResponse } from './dto/topology-response.dto';
import { projectNodeMeta } from './topology.derive';
import {
  toCableResponse,
  toCircuitResponse,
  toClosureResponse,
  toNodeResponse,
  toSpliceResponse,
  toSplitterResponse,
  toStrandResponse,
} from './topology.mappers';
import { TopologyRepository } from './topology.repository';

type ListResponse<T> = { items: T[]; total: number };

/**
 * Read surface for the topology + OSP cabling layer. The node graph is returned
 * with read-time PROJECTED meta (splitter/ports/coreNo are derived from the
 * cabling, never hand-maintained); the cabling entities are returned as the wire
 * contract the FE already expects. Seeds on first access (mock-first island,
 * ADR-0003): topology owns its synthetic subscriber set.
 */
@Injectable()
export class TopologyService {
  constructor(private readonly repo: TopologyRepository) {}

  async getTopology(): Promise<TopologyResponse> {
    await this.repo.ensureSeeded();
    const [nodes, splitters, strands] = await Promise.all([
      this.repo.listNodes(),
      this.repo.listSplitters(),
      this.repo.listStrands(),
    ]);
    const projected = projectNodeMeta(nodes, { splitters, strands });
    const items = projected.map(toNodeResponse);
    return { items, total: items.length };
  }

  async listCables(): Promise<ListResponse<CableResponse>> {
    await this.repo.ensureSeeded();
    return wrap((await this.repo.listCables()).map(toCableResponse));
  }

  async listStrands(): Promise<ListResponse<StrandResponse>> {
    await this.repo.ensureSeeded();
    return wrap((await this.repo.listStrands()).map(toStrandResponse));
  }

  async listSplitters(): Promise<ListResponse<SplitterResponse>> {
    await this.repo.ensureSeeded();
    return wrap((await this.repo.listSplitters()).map(toSplitterResponse));
  }

  async listClosures(): Promise<ListResponse<ClosureResponse>> {
    await this.repo.ensureSeeded();
    return wrap((await this.repo.listClosures()).map(toClosureResponse));
  }

  async listSplices(): Promise<ListResponse<SpliceResponse>> {
    await this.repo.ensureSeeded();
    return wrap((await this.repo.listSplices()).map(toSpliceResponse));
  }

  async listCircuits(): Promise<ListResponse<CircuitResponse>> {
    await this.repo.ensureSeeded();
    return wrap((await this.repo.listCircuits()).map(toCircuitResponse));
  }
}

const wrap = <T>(items: T[]): ListResponse<T> => ({ items, total: items.length });
