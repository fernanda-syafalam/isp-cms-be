import type {
  NewCable,
  NewCircuit,
  NewSplice,
  NewSplitter,
  NewStrand,
  SplitterPort,
  SplitterRow,
} from '../../infrastructure/database/schema/topology.schema';
import { ratioCount, segmentMeters } from './topology.graph';

// Pure planners for the OSP capacity layer. They compute the rows + updated
// splitter ports for a mutation but write NOTHING — the repository persists them
// inside a transaction. Mirrors the FE cabling fixtures (allocateDrop /
// setSplitterRatio / freeDrop port reset) so the contract matches exactly.

type SplitterRatioValue = SplitterRow['ratio'];
type Point = { id: string; lat: number; lng: number };
// Connection facts may be absent/null for a not-yet-provisioned subscriber.
type Connection = {
  ponPort?: string | null | undefined;
  onuSerial?: string | null | undefined;
};

const DROP_SPEC = 'G.652D 12F drop';

function makePorts(count: number): SplitterPort[] {
  return Array.from({ length: count }, (_, i) => ({
    portNo: i + 1,
    outNodeId: null,
    customerId: null,
    strandId: null,
  }));
}

function dropCable(from: Point, to: Point, id: string, planned: boolean): NewCable {
  return {
    id,
    kind: 'drop',
    spec: DROP_SPEC,
    fiberCount: 12,
    tubeCount: 1,
    fromNodeId: from.id,
    toNodeId: to.id,
    route: [
      { lat: from.lat, lng: from.lng },
      { lat: to.lat, lng: to.lng },
    ],
    lengthM: segmentMeters(from, to),
    status: planned ? 'planned' : 'installed',
    installedAt: null,
  };
}

// A fusion splice inside the ODP closure joining the (logical) distribution feed
// to the customer's drop strand. The feeder cable is rendered from parentId edges
// (not stored), so the in-side references it by a derived id.
function dropSplice(odpId: string, strand: NewStrand): NewSplice {
  return {
    id: `${strand.id}-splice`,
    closureId: `${odpId}-closure`,
    inCableId: `${odpId}-feeder`,
    inTubeNo: 1,
    inCoreNo: ((strand.coreNo - 1) % 12) + 1,
    outCableId: strand.cableId,
    outTubeNo: strand.tubeNo,
    outCoreNo: strand.coreNo,
    type: 'fusion',
    lossDb: 0.1,
  };
}

export type DropPlan = {
  // Assigned fiber core for the customer node meta (= the port number; tube 1).
  coreNo: number;
  cable: NewCable;
  strand: NewStrand;
  splice: NewSplice;
  circuit: NewCircuit;
  // The host splitter's full ports array with the chosen port now bound.
  ports: SplitterPort[];
};

/**
 * Plan a customer drop on a free ODP splitter port (mirrors FE `allocateDrop`):
 * a fresh install ⇒ tube 1, core = port number, strand `allocated`, drop cable
 * `installed`, circuit `active`. Ids are deterministic (one drop per customer) so
 * a re-install after a delete reuses them cleanly. Returns null when the splitter
 * is full, or when the requested `portNo` is taken/absent.
 */
export function planDrop(args: {
  splitter: SplitterRow;
  odp: Point;
  oltNodeId: string;
  customerId: string;
  customerNodeId: string;
  customerPoint: { lat: number; lng: number };
  conn: Connection;
  portNo?: number | undefined;
}): DropPlan | null {
  const { splitter, odp, oltNodeId, customerId, customerNodeId, customerPoint, conn, portNo } =
    args;
  const port =
    portNo != null
      ? splitter.ports.find((p) => p.portNo === portNo && p.outNodeId === null)
      : splitter.ports.find((p) => p.outNodeId === null);
  if (!port) return null;

  const cableId = `${customerNodeId}-drop`;
  const strandId = `${customerNodeId}-strand`;
  const circuitId = `${customerId}-circuit`;
  const cable = dropCable(odp, { id: customerNodeId, ...customerPoint }, cableId, false);
  const strand: NewStrand = {
    id: strandId,
    cableId,
    tubeNo: 1,
    coreNo: port.portNo,
    status: 'allocated',
    circuitId,
    customerId,
  };
  const splice = dropSplice(odp.id, strand);
  const circuit: NewCircuit = {
    id: circuitId,
    customerId,
    customerNodeId,
    oltNodeId,
    oltPonPort: conn.ponPort ?? '0/0/0',
    onuSerial: conn.onuSerial ?? null,
    status: 'active',
  };
  const ports: SplitterPort[] = splitter.ports.map((p) =>
    p.portNo === port.portNo
      ? { portNo: p.portNo, outNodeId: customerNodeId, customerId, strandId }
      : p,
  );
  return { coreNo: port.portNo, cable, strand, splice, circuit, ports };
}

/**
 * Clear every port a customer occupies (mirrors the port reset in FE `freeDrop`).
 * Returns a fresh ports array; the caller persists it and deletes the drop rows.
 */
export function clearPortsFor(
  ports: SplitterPort[],
  customerId: string,
  customerNodeId: string,
): SplitterPort[] {
  return ports.map((p) =>
    p.customerId === customerId || p.outNodeId === customerNodeId
      ? { portNo: p.portNo, outNodeId: null, customerId: null, strandId: null }
      : p,
  );
}

/**
 * Provision/resize an ODC/ODP splitter to `ratio` (mirrors FE `setSplitterRatio`):
 * a missing splitter is created fresh; growing appends free ports; shrinking
 * truncates — but REFUSES (null) a shrink that would orphan an occupied port.
 */
export function planSplitterRatio(
  existing: SplitterRow | undefined,
  nodeId: string,
  ratio: SplitterRatioValue,
): NewSplitter | null {
  const newSize = ratioCount(ratio);
  if (!existing) {
    return {
      id: `${nodeId}-splitter`,
      nodeId,
      ratio,
      inCableId: null,
      inStrandId: null,
      ports: makePorts(newSize),
    };
  }
  let ports = existing.ports;
  if (newSize < ports.length) {
    if (ports.slice(newSize).some((p) => p.outNodeId !== null)) return null; // would orphan a drop
    ports = ports.slice(0, newSize);
  } else if (newSize > ports.length) {
    ports = [
      ...ports,
      ...Array.from({ length: newSize - ports.length }, (_, i) => ({
        portNo: ports.length + i + 1,
        outNodeId: null,
        customerId: null,
        strandId: null,
      })),
    ];
  }
  return {
    id: existing.id,
    nodeId,
    ratio,
    inCableId: existing.inCableId,
    inStrandId: existing.inStrandId,
    ports,
  };
}
