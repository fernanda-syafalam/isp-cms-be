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
import type { NetworkNodeResponse } from './dto/topology-response.dto';

// Pure row -> wire-contract mappers, shared by the read service (lists) and the
// mutation service (single-entity responses). Single source of truth so the two
// paths never drift in shape.

export function toNodeResponse(row: NetworkNodeRow): NetworkNodeResponse {
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

export function toCableResponse(row: CableRow): CableResponse {
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

export function toStrandResponse(row: StrandRow): StrandResponse {
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

export function toSplitterResponse(row: SplitterRow): SplitterResponse {
  return {
    id: row.id,
    nodeId: row.nodeId,
    ratio: row.ratio,
    inCableId: row.inCableId,
    inStrandId: row.inStrandId,
    ports: row.ports,
  };
}

export function toClosureResponse(row: ClosureRow): ClosureResponse {
  return {
    id: row.id,
    type: row.type,
    nodeId: row.nodeId,
    trayCapacity: row.trayCapacity,
    fiberCapacity: row.fiberCapacity,
  };
}

export function toSpliceResponse(row: SpliceRow): SpliceResponse {
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

export function toCircuitResponse(row: CircuitRow): CircuitResponse {
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
