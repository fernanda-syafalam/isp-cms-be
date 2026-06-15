import type {
  NetworkNodeRow,
  NewCable,
  NewCircuit,
  NewClosure,
  NewNetworkNode,
  NewSplice,
  NewSplitter,
  NewStrand,
  NodeMeta,
  SplitterPort,
  SplitterRow,
  StrandRow,
} from '../../infrastructure/database/schema/topology.schema';
import { fiberId, indexById, oltOf, ratioCount, segmentMeters, servingOdp } from './topology.graph';

export type DerivedCabling = {
  cables: NewCable[];
  strands: NewStrand[];
  splitters: NewSplitter[];
  closures: NewClosure[];
  splices: NewSplice[];
  circuits: NewCircuit[];
};

const splitterRatioFor = (type: NewNetworkNode['type']): '1:4' | '1:8' =>
  type === 'odc' ? '1:4' : '1:8';

function dropCable(
  from: { id: string; lat: number; lng: number },
  to: { id: string; lat: number; lng: number },
  id: string,
  planned: boolean,
): NewCable {
  return {
    id,
    kind: 'drop',
    spec: 'G.652D 12F drop',
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

// A fusion splice inside an ODP closure joining the distribution feed to a
// customer's drop strand. The feeder cable is rendered from parentId edges (not
// stored), so the in-side references it by a derived id.
function dropSplice(odp: { id: string }, strand: NewStrand): NewSplice {
  return {
    id: `${strand.id}-splice`,
    closureId: `${odp.id}-closure`,
    inCableId: `${odp.id}-feeder`,
    inTubeNo: 1,
    inCoreNo: ((strand.coreNo - 1) % 12) + 1,
    outCableId: strand.cableId,
    outTubeNo: strand.tubeNo,
    outCoreNo: strand.coreNo,
    type: 'fusion',
    lossDb: 0.1,
  };
}

/**
 * Derive the OSP cabling layer FROM the topology nodes so the physical layer and
 * the node graph are consistent by construction: a splitter + closure on every
 * ODC (1:4) / ODP (1:8), ODC ports feeding ODP children, and one drop
 * cable+strand+circuit+ODP-port per customer (tube/core preserved from the
 * customer's coreNo). Mirrors the FE deriveCabling so the contract matches.
 */
export function deriveCabling(nodes: NewNetworkNode[]): DerivedCabling {
  const byId = indexById(nodes);
  const splitters: NewSplitter[] = [];
  const closures: NewClosure[] = [];
  const cables: NewCable[] = [];
  const strands: NewStrand[] = [];
  const splices: NewSplice[] = [];
  const circuits: NewCircuit[] = [];

  for (const n of nodes) {
    if (n.type !== 'odc' && n.type !== 'odp') continue;
    const ratio = splitterRatioFor(n.type);
    const count = ratioCount(ratio);
    const ports: SplitterPort[] = Array.from({ length: count }, (_, i) => ({
      portNo: i + 1,
      outNodeId: null,
      customerId: null,
      strandId: null,
    }));
    splitters.push({
      id: `${n.id}-splitter`,
      nodeId: n.id,
      ratio,
      inCableId: null,
      inStrandId: null,
      ports,
    });
    closures.push({
      id: `${n.id}-closure`,
      type: n.type === 'odc' ? 'odc' : 'odp',
      nodeId: n.id,
      trayCapacity: Math.max(1, Math.ceil(count / 12)),
      fiberCapacity: count,
    });
  }
  const splitterByNode = new Map(splitters.map((s) => [s.nodeId, s]));

  // ODC splitter ports feed ODP children (distribution tier).
  for (const n of nodes) {
    if (n.type !== 'odp' || !n.parentId) continue;
    const odc = byId.get(n.parentId);
    if (odc?.type !== 'odc') continue;
    const port = splitterByNode.get(odc.id)?.ports.find((p) => p.outNodeId === null);
    if (port) port.outNodeId = n.id;
  }

  // Each customer drop: strand (tube/core from its coreNo so colours are
  // preserved) + drop cable + circuit + an ODP splitter port.
  for (const n of nodes) {
    if (n.type !== 'customer') continue;
    const customerId = n.meta?.customerId;
    const odp = servingOdp(n, byId);
    if (!customerId || !odp) continue; // tolerate orphan customers
    const splitter = splitterByNode.get(odp.id);
    const port = splitter?.ports.find((p) => p.outNodeId === null);
    if (!port) continue; // overflow: ODP splitter full — skip this drop

    const fid = fiberId(n.meta?.coreNo ?? port.portNo);
    const cableId = `${n.id}-drop`;
    const strandId = `${n.id}-strand`;
    const circuitId = `${customerId}-circuit`;
    cables.push(dropCable(odp, n, cableId, n.status === 'unknown'));
    const strand: NewStrand = {
      id: strandId,
      cableId,
      tubeNo: fid.tubeNo,
      coreNo: fid.coreNo,
      status: n.status === 'down' ? 'dead' : 'allocated',
      circuitId,
      customerId,
    };
    strands.push(strand);
    splices.push(dropSplice(odp, strand));
    circuits.push({
      id: circuitId,
      customerId,
      customerNodeId: n.id,
      oltNodeId: oltOf(n, byId)?.id ?? odp.id,
      oltPonPort: n.meta?.ponPort ?? '0/0/0',
      onuSerial: n.meta?.onuSerial ?? null,
      status: n.status === 'down' ? 'down' : 'active',
    });
    port.outNodeId = n.id;
    port.customerId = customerId;
    port.strandId = strandId;
  }

  return { cables, strands, splitters, closures, splices, circuits };
}

/**
 * Cabling is the source of truth; node.meta is a PROJECTION of it. Merge the
 * cabling-derived fields (splitter/portsTotal/portsUsed for ODC/ODP, coreNo for
 * a customer) onto each node's existing meta — every pass-through fact (model,
 * ipAddress, planName, phone, onuSerial, ponPort, rxPowerDbm, customerId) is
 * preserved. portsUsed therefore reflects true occupancy, never hand-maintained.
 */
export function projectNodeMeta(
  nodes: NetworkNodeRow[],
  cabling: { splitters: SplitterRow[]; strands: StrandRow[] },
): NetworkNodeRow[] {
  const splitterByNode = new Map<string, SplitterRow>();
  for (const s of cabling.splitters) splitterByNode.set(s.nodeId, s);
  const dropStrandByCustomer = new Map<string, StrandRow>();
  for (const st of cabling.strands) {
    if (st.customerId) dropStrandByCustomer.set(st.customerId, st);
  }

  return nodes.map((node) => {
    const splitter = splitterByNode.get(node.id);
    const customerId = node.meta?.customerId;
    const strand = customerId ? dropStrandByCustomer.get(customerId) : undefined;
    if (!splitter && !strand) return node;

    const meta: NodeMeta = { ...node.meta };
    if (splitter) {
      meta.splitter = splitter.ratio;
      meta.portsTotal = ratioCount(splitter.ratio);
      meta.portsUsed = splitter.ports.filter((p) => p.outNodeId !== null).length;
    }
    if (strand) meta.coreNo = (strand.tubeNo - 1) * 12 + strand.coreNo;
    return { ...node, meta };
  });
}
