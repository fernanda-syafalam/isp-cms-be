import { Injectable } from '@nestjs/common';
import type {
  CableRow,
  CircuitRow,
  ClosureRow,
  NetworkNodeRow,
  SpliceRow,
  SplitterRow,
  StrandRow,
} from '../../infrastructure/database/schema/topology.schema';
import type {
  CableResponse,
  CircuitResponse,
  ClosureResponse,
  SpliceResponse,
  SplitterResponse,
  StrandResponse,
} from './dto/cabling-response.dto';
import type { NetworkNodeResponse, TopologyResponse } from './dto/topology-response.dto';
import { projectNodeMeta } from './topology.derive';
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

function toNodeResponse(row: NetworkNodeRow): NetworkNodeResponse {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    lat: row.lat,
    lng: row.lng,
    parentId: row.parentId,
    ...(row.meta ? { meta: row.meta } : {}),
  };
}

function toCableResponse(row: CableRow): CableResponse {
  return {
    id: row.id,
    kind: row.kind,
    spec: row.spec,
    fiberCount: row.fiberCount,
    tubeCount: row.tubeCount,
    fromNodeId: row.fromNodeId,
    toNodeId: row.toNodeId,
    route: row.route,
    lengthM: row.lengthM,
    status: row.status,
    installedAt: row.installedAt ? row.installedAt.toISOString() : null,
  };
}

function toStrandResponse(row: StrandRow): StrandResponse {
  return {
    id: row.id,
    cableId: row.cableId,
    tubeNo: row.tubeNo,
    coreNo: row.coreNo,
    status: row.status,
    circuitId: row.circuitId,
    customerId: row.customerId,
  };
}

function toSplitterResponse(row: SplitterRow): SplitterResponse {
  return {
    id: row.id,
    nodeId: row.nodeId,
    ratio: row.ratio,
    inCableId: row.inCableId,
    inStrandId: row.inStrandId,
    ports: row.ports,
  };
}

function toClosureResponse(row: ClosureRow): ClosureResponse {
  return {
    id: row.id,
    type: row.type,
    nodeId: row.nodeId,
    trayCapacity: row.trayCapacity,
    fiberCapacity: row.fiberCapacity,
  };
}

function toSpliceResponse(row: SpliceRow): SpliceResponse {
  return {
    id: row.id,
    closureId: row.closureId,
    inCableId: row.inCableId,
    inTubeNo: row.inTubeNo,
    inCoreNo: row.inCoreNo,
    outCableId: row.outCableId,
    outTubeNo: row.outTubeNo,
    outCoreNo: row.outCoreNo,
    type: row.type,
    lossDb: row.lossDb,
  };
}

function toCircuitResponse(row: CircuitRow): CircuitResponse {
  return {
    id: row.id,
    customerId: row.customerId,
    customerNodeId: row.customerNodeId,
    oltNodeId: row.oltNodeId,
    oltPonPort: row.oltPonPort,
    onuSerial: row.onuSerial,
    status: row.status,
  };
}
