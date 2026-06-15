import { describe, expect, it } from 'vitest';
import type {
  SplitterPort,
  SplitterRow,
} from '../../infrastructure/database/schema/topology.schema';
import { clearPortsFor, planDrop, planSplitterRatio } from './topology.allocator';

const port = (n: number, customerId: string | null): SplitterPort => ({
  portNo: n,
  outNodeId: customerId ? `${customerId}-node` : null,
  customerId,
  strandId: customerId ? `${customerId}-node-strand` : null,
});

const splitter = (ports: SplitterPort[]): SplitterRow => ({
  id: 'odp-1-splitter',
  nodeId: 'odp-1',
  ratio: '1:8',
  inCableId: null,
  inStrandId: null,
  ports,
});

const dropArgs = {
  odp: { id: 'odp-1', lat: -6.55, lng: 110.68 },
  oltNodeId: 'olt-1',
  customerId: 'cust-9',
  customerNodeId: 'cust-9-node',
  customerPoint: { lat: -6.56, lng: 110.69 },
  conn: { ponPort: '0/1/9', onuSerial: 'ZTEG10000009' },
};

describe('planDrop', () => {
  it('allocates the first free port and builds deterministic drop rows', () => {
    const plan = planDrop({
      splitter: splitter([port(1, 'cust-1'), port(2, null), port(3, null)]),
      ...dropArgs,
    });
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.coreNo).toBe(2); // first free port
    expect(plan.cable.id).toBe('cust-9-node-drop');
    expect(plan.strand.id).toBe('cust-9-node-strand');
    expect(plan.strand.tubeNo).toBe(1);
    expect(plan.strand.coreNo).toBe(2);
    expect(plan.circuit.id).toBe('cust-9-circuit');
    expect(plan.circuit.oltPonPort).toBe('0/1/9');
    expect(plan.circuit.onuSerial).toBe('ZTEG10000009');
    // The chosen port is now bound; the others are untouched.
    expect(plan.ports[1]).toMatchObject({ portNo: 2, customerId: 'cust-9' });
    expect(plan.ports[0]?.customerId).toBe('cust-1');
  });

  it('honors an explicit free port number', () => {
    const plan = planDrop({
      splitter: splitter([port(1, null), port(2, null), port(3, null)]),
      portNo: 3,
      ...dropArgs,
    });
    expect(plan?.coreNo).toBe(3);
  });

  it('returns null when the requested port is already taken', () => {
    const plan = planDrop({
      splitter: splitter([port(1, 'cust-1'), port(2, null)]),
      portNo: 1,
      ...dropArgs,
    });
    expect(plan).toBeNull();
  });

  it('returns null when the splitter is full', () => {
    const plan = planDrop({
      splitter: splitter([port(1, 'cust-1'), port(2, 'cust-2')]),
      ...dropArgs,
    });
    expect(plan).toBeNull();
  });

  it('defaults the PON port when the subscriber has no connection facts', () => {
    const plan = planDrop({
      splitter: splitter([port(1, null)]),
      ...dropArgs,
      conn: { ponPort: null, onuSerial: null },
    });
    expect(plan?.circuit.oltPonPort).toBe('0/0/0');
    expect(plan?.circuit.onuSerial).toBeNull();
  });
});

describe('clearPortsFor', () => {
  it('frees only the ports a customer occupies', () => {
    const cleared = clearPortsFor([port(1, 'cust-1'), port(2, 'cust-2')], 'cust-1', 'cust-1-node');
    expect(cleared[0]).toMatchObject({ portNo: 1, outNodeId: null, customerId: null });
    expect(cleared[1]?.customerId).toBe('cust-2');
  });
});

describe('planSplitterRatio', () => {
  it('creates a fresh splitter sized to the ratio', () => {
    const plan = planSplitterRatio(undefined, 'odp-9', '1:4');
    expect(plan?.id).toBe('odp-9-splitter');
    expect(plan?.ports).toHaveLength(4);
  });

  it('grows by appending free ports and keeps occupancy', () => {
    const existing = splitter([port(1, 'cust-1'), port(2, null), port(3, null), port(4, null)]);
    const plan = planSplitterRatio({ ...existing, ratio: '1:4' }, 'odp-1', '1:8');
    expect(plan?.ports).toHaveLength(8);
    expect(plan?.ports[0]?.customerId).toBe('cust-1');
  });

  it('shrinks when the dropped ports are free', () => {
    const existing = splitter([
      port(1, 'cust-1'),
      port(2, null),
      port(3, null),
      port(4, null),
      port(5, null),
      port(6, null),
      port(7, null),
      port(8, null),
    ]);
    const plan = planSplitterRatio(existing, 'odp-1', '1:4');
    expect(plan?.ports).toHaveLength(4);
  });

  it('refuses a shrink that would orphan an occupied port', () => {
    const existing = splitter([
      port(1, null),
      port(2, null),
      port(3, null),
      port(4, null),
      port(5, null),
      port(6, 'cust-6'),
      port(7, null),
      port(8, null),
    ]);
    expect(planSplitterRatio(existing, 'odp-1', '1:4')).toBeNull();
  });
});
