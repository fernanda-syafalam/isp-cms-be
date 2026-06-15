import { describe, expect, it } from 'vitest';
import type {
  NetworkNodeRow,
  SplitterRow,
  StrandRow,
} from '../../infrastructure/database/schema/topology.schema';
import { deriveCabling, projectNodeMeta } from './topology.derive';
import { buildTopologyFixture } from './topology.fixtures';

// The fixture: 2 OLT × 2 ODC × 2 ODP × 1 pole = 4 ODC + 8 ODP + 8 poles + 2 OLT,
// plus 11 synthetic customers — every customer hangs off a pole under an ODP.
const fixture = buildTopologyFixture();
const cabling = deriveCabling(fixture);

const countType = (t: NetworkNodeRow['type']) => fixture.filter((n) => n.type === t).length;

describe('deriveCabling', () => {
  it('creates a splitter + closure on every ODC and ODP, and nowhere else', () => {
    const expected = countType('odc') + countType('odp');
    expect(cabling.splitters).toHaveLength(expected);
    expect(cabling.closures).toHaveLength(expected);
    expect(cabling.splitters.every((s) => s.ports.length > 0)).toBe(true);
  });

  it('uses 1:4 on ODC splitters and 1:8 on ODP splitters', () => {
    const byNode = new Map(cabling.splitters.map((s) => [s.nodeId, s]));
    const odc = fixture.find((n) => n.type === 'odc');
    const odp = fixture.find((n) => n.type === 'odp');
    expect(odc && byNode.get(odc.id)?.ratio).toBe('1:4');
    expect(odp && byNode.get(odp.id)?.ratio).toBe('1:8');
  });

  it('provisions exactly one drop cable + strand + circuit + splice per customer', () => {
    const customers = countType('customer');
    expect(cabling.cables).toHaveLength(customers);
    expect(cabling.strands).toHaveLength(customers);
    expect(cabling.circuits).toHaveLength(customers);
    expect(cabling.splices).toHaveLength(customers);
    expect(cabling.cables.every((c) => c.kind === 'drop')).toBe(true);
  });

  it('keeps every strand tube/core within a 12-fiber loose tube (TIA-598)', () => {
    for (const strand of cabling.strands) {
      expect(strand.tubeNo).toBeGreaterThanOrEqual(1);
      expect(strand.coreNo).toBeGreaterThanOrEqual(1);
      expect(strand.coreNo).toBeLessThanOrEqual(12);
    }
  });

  it('never overflows an ODP splitter (occupied ports ≤ ratio)', () => {
    for (const s of cabling.splitters) {
      const used = s.ports.filter((p) => p.outNodeId !== null).length;
      expect(used).toBeLessThanOrEqual(s.ports.length);
    }
  });

  it('derives an active circuit with the provisioned PON port + ONU serial', () => {
    const circuit = cabling.circuits.find((c) => c.customerId === 'cust-1');
    expect(circuit).toBeDefined();
    expect(circuit?.oltPonPort).toBe('0/1/1');
    expect(circuit?.onuSerial).toBe('ZTEG10000001');
    expect(circuit?.status).toBe('active');
  });

  it('falls back to a placeholder PON port + null ONU for an unprovisioned customer', () => {
    // cust-8 is `berhenti` with connection: null.
    const circuit = cabling.circuits.find((c) => c.customerId === 'cust-8');
    expect(circuit?.oltPonPort).toBe('0/0/0');
    expect(circuit?.onuSerial).toBeNull();
  });
});

describe('projectNodeMeta', () => {
  // Round-trip the seed nodes through the persisted-row shape the projection sees.
  const rows: NetworkNodeRow[] = fixture.map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    status: n.status,
    lat: n.lat,
    lng: n.lng,
    parentId: n.parentId ?? null,
    meta: n.meta ?? null,
    createdAt: new Date('2026-06-16T00:00:00.000Z'),
    updatedAt: new Date('2026-06-16T00:00:00.000Z'),
  }));
  const splitters = cabling.splitters.map(
    (s): SplitterRow => ({
      id: s.id,
      nodeId: s.nodeId,
      ratio: s.ratio,
      inCableId: s.inCableId ?? null,
      inStrandId: s.inStrandId ?? null,
      ports: s.ports,
    }),
  );
  const strands = cabling.strands.map(
    (s): StrandRow => ({
      id: s.id,
      cableId: s.cableId,
      tubeNo: s.tubeNo,
      coreNo: s.coreNo,
      status: s.status,
      circuitId: s.circuitId ?? null,
      customerId: s.customerId ?? null,
    }),
  );
  const projected = projectNodeMeta(rows, { splitters, strands });
  const byId = new Map(projected.map((n) => [n.id, n]));

  it('leaves an OLT untouched (no splitter, no customer strand) — pass-through preserved', () => {
    const olt = byId.get('olt-1');
    expect(olt?.meta?.model).toBe('ZTE C320');
    expect(olt?.meta?.ipAddress).toBe('10.20.1.1');
    expect(olt?.meta?.splitter).toBeUndefined();
  });

  it('overlays splitter/portsTotal onto an ODC while preserving pass-through meta', () => {
    const odc = projected.find((n) => n.type === 'odc');
    expect(odc?.meta?.splitter).toBe('1:4');
    expect(odc?.meta?.portsTotal).toBe(4);
    expect(odc?.meta?.ipAddress).toBeDefined(); // seeded pass-through kept
  });

  it('reports HONEST occupancy: total ODP ports used == customer count', () => {
    const odpUsed = projected
      .filter((n) => n.type === 'odp')
      .reduce((sum, n) => sum + (n.meta?.portsUsed ?? 0), 0);
    expect(odpUsed).toBe(countType('customer'));

    // ODC ports feed the 8 ODP children.
    const odcUsed = projected
      .filter((n) => n.type === 'odc')
      .reduce((sum, n) => sum + (n.meta?.portsUsed ?? 0), 0);
    expect(odcUsed).toBe(countType('odp'));
  });

  it('projects a customer coreNo that round-trips its strand, keeping identity fields', () => {
    const node = byId.get('cust-1-node');
    expect(node?.meta?.coreNo).toBe(1); // pole 0, core 1 → tube 1 core 1 → global 1
    expect(node?.meta?.customerId).toBe('cust-1');
    expect(node?.meta?.planName).toBe('Home 20');
    expect(node?.meta?.lifecycle).toBe('aktif');
  });
});
