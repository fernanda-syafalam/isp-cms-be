import type {
  NetworkNodeRow,
  NodeMeta,
} from '../../infrastructure/database/schema/topology.schema';

// Structural node shape the derivation/projection helpers operate on — a subset
// of the persisted row, so both seed fixtures (NewNetworkNode) and DB rows work.
export type TopoNode = {
  id: string;
  type: NetworkNodeRow['type'];
  status: NetworkNodeRow['status'];
  lat: number;
  lng: number;
  parentId?: string | null;
  meta?: NodeMeta | null;
};

export function indexById<T extends { id: string }>(nodes: T[]): Map<string, T> {
  return new Map(nodes.map((n) => [n.id, n]));
}

// Output-port count of a PON splitter ratio: "1:8" -> 8. The capacity of an
// ODC/ODP, derived from its splitter rather than hand-set.
export function ratioCount(ratio: string): number {
  const n = Number(ratio.split(':')[1]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// A loose-tube cable groups fibers into buffer tubes of 12. A global fiber
// number resolves to its tube + position within that tube (TIA-598-C).
export function fiberId(globalNo: number): { tubeNo: number; coreNo: number } {
  return { tubeNo: Math.ceil(globalNo / 12), coreNo: ((globalNo - 1) % 12) + 1 };
}

// Haversine distance (m) between two coordinates — the physical cable length of
// the segment between a node and its uplink.
export function segmentMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

// Total surveyed length (m) of a polyline route: the sum of its segment lengths.
// A re-routed cable's lengthM is recomputed from its new waypoints this way.
export function routeLength(points: Array<{ lat: number; lng: number }>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) total += segmentMeters(a, b);
  }
  return total;
}

// Uplink path from a node up to the OLT root (inclusive), nearest first.
export function uplinkPath<T extends TopoNode>(start: T, byId: Map<string, T>): T[] {
  const path: T[] = [start];
  const seen = new Set<string>([start.id]);
  let current: T = start;
  while (current.parentId) {
    const parent = byId.get(current.parentId);
    if (!parent || seen.has(parent.id)) break;
    path.push(parent);
    seen.add(parent.id);
    current = parent;
  }
  return path;
}

// First ODP on a node's uplink (customers may hang off a pole under the ODP).
export function servingOdp<T extends TopoNode>(node: T, byId: Map<string, T>): T | undefined {
  return uplinkPath(node, byId).find((n) => n.type === 'odp');
}

// First OLT on a node's uplink.
export function oltOf<T extends TopoNode>(node: T, byId: Map<string, T>): T | undefined {
  return uplinkPath(node, byId).find((n) => n.type === 'olt');
}
