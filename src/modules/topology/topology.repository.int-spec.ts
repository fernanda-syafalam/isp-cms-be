import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import {
  cables,
  circuits,
  closures,
  networkNodes,
  splices,
  splitters,
  strands,
} from '../../infrastructure/database/schema/topology.schema';
import { routeLength } from './topology.graph';
import { TopologyRepository } from './topology.repository';

/**
 * Real Postgres integration test for TopologyRepository. Requires Docker.
 * Schema applied by hand (mirroring migration 0026).
 */
describe('TopologyRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: TopologyRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE node_type AS ENUM ('olt', 'odc', 'odp', 'pole', 'customer');
      CREATE TYPE node_status AS ENUM ('up', 'down', 'unknown');
      CREATE TYPE cable_kind AS ENUM ('feeder', 'distribution', 'drop');
      CREATE TYPE cable_status AS ENUM ('planned', 'installed', 'retired');
      CREATE TYPE strand_status AS ENUM ('allocated', 'reserved', 'dead');
      CREATE TYPE splitter_ratio AS ENUM ('1:2', '1:4', '1:8', '1:16', '1:32', '1:64');
      CREATE TYPE closure_type AS ENUM ('odc', 'odp', 'joint', 'inline');
      CREATE TYPE splice_type AS ENUM ('fusion', 'mechanical', 'passthrough');
      CREATE TYPE circuit_status AS ENUM ('active', 'planned', 'down');

      CREATE TABLE network_nodes (
        id varchar(120) PRIMARY KEY,
        name varchar(160) NOT NULL,
        type node_type NOT NULL,
        status node_status NOT NULL,
        lat double precision NOT NULL,
        lng double precision NOT NULL,
        parent_id varchar(120),
        meta jsonb,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TABLE cables (
        id varchar(120) PRIMARY KEY,
        kind cable_kind NOT NULL,
        spec varchar(120) NOT NULL,
        fiber_count integer NOT NULL,
        tube_count integer NOT NULL,
        from_node_id varchar(120) NOT NULL,
        to_node_id varchar(120) NOT NULL,
        route jsonb NOT NULL,
        length_m double precision NOT NULL,
        status cable_status NOT NULL,
        installed_at timestamptz(3)
      );
      CREATE TABLE strands (
        id varchar(120) PRIMARY KEY,
        cable_id varchar(120) NOT NULL,
        tube_no integer NOT NULL,
        core_no integer NOT NULL,
        status strand_status NOT NULL,
        circuit_id varchar(120),
        customer_id varchar(120)
      );
      CREATE TABLE splitters (
        id varchar(120) PRIMARY KEY,
        node_id varchar(120) NOT NULL,
        ratio splitter_ratio NOT NULL,
        in_cable_id varchar(120),
        in_strand_id varchar(120),
        ports jsonb NOT NULL
      );
      CREATE TABLE closures (
        id varchar(120) PRIMARY KEY,
        type closure_type NOT NULL,
        node_id varchar(120) NOT NULL,
        tray_capacity integer NOT NULL,
        fiber_capacity integer NOT NULL
      );
      CREATE TABLE splices (
        id varchar(120) PRIMARY KEY,
        closure_id varchar(120) NOT NULL,
        in_cable_id varchar(120) NOT NULL,
        in_tube_no integer NOT NULL,
        in_core_no integer NOT NULL,
        out_cable_id varchar(120) NOT NULL,
        out_tube_no integer NOT NULL,
        out_core_no integer NOT NULL,
        type splice_type NOT NULL,
        loss_db double precision NOT NULL
      );
      CREATE TABLE circuits (
        id varchar(120) PRIMARY KEY,
        customer_id varchar(120) NOT NULL,
        customer_node_id varchar(120) NOT NULL,
        olt_node_id varchar(120) NOT NULL,
        olt_pon_port varchar(40) NOT NULL,
        onu_serial varchar(120),
        status circuit_status NOT NULL
      );
    `);

    repo = new TopologyRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      db.delete(splices),
      db.delete(strands),
      db.delete(circuits),
      db.delete(splitters),
      db.delete(closures),
      db.delete(cables),
    ]);
    await db.delete(networkNodes);
  });

  it('seeds the node forest + derived cabling on first read', async () => {
    await repo.ensureSeeded();

    const nodes = await repo.listNodes();
    // 2 OLT + 4 ODC + 8 ODP + 8 poles + 11 customers = 33.
    expect(nodes).toHaveLength(33);

    const splitterRows = await repo.listSplitters();
    expect(splitterRows).toHaveLength(12); // 4 ODC + 8 ODP

    const strandRows = await repo.listStrands();
    const circuitRows = await repo.listCircuits();
    expect(strandRows).toHaveLength(11); // one drop per customer
    expect(circuitRows).toHaveLength(11);

    // jsonb round-trips: a splitter keeps its typed ports array.
    expect(Array.isArray(splitterRows[0]?.ports)).toBe(true);
  });

  it('ensureSeeded is idempotent — a second run inserts nothing', async () => {
    await repo.ensureSeeded();
    const first = await repo.listNodes();
    await repo.ensureSeeded();
    const second = await repo.listNodes();
    expect(second).toHaveLength(first.length);
  });

  it('orders list results deterministically by id', async () => {
    await repo.ensureSeeded();
    const cableRows = await repo.listCables();
    const ids = cableRows.map((c) => c.id);
    expect(ids).toEqual([...ids].sort());
  });

  // ---- Write surface --------------------------------------------------------

  // A pending subscriber (cust-12) — in the catalogue but not seeded as a node.
  const drop12 = {
    customerId: 'cust-12',
    customerNodeId: 'cust-12-node',
    odpId: 'olt-1-odc-1-odp-1',
    name: 'Lukman Hakim',
    netStatus: 'up' as const,
    lat: -6.55,
    lng: 110.68,
    metaBase: { customerId: 'cust-12', planName: 'Home 50', lifecycle: 'aktif' as const },
    conn: { ponPort: '0/3/3', onuSerial: 'ZTEG10000012' },
  };

  const splitterOf = async (nodeId: string) => {
    const [row] = await db.select().from(splitters).where(eq(splitters.nodeId, nodeId));
    return row;
  };

  it('customerDrop allocates a port and creates the drop cabling + node', async () => {
    await repo.ensureSeeded();
    const before = await splitterOf(drop12.odpId);
    const freeBefore = before?.ports.filter((p) => p.outNodeId === null).length ?? 0;

    const node = await repo.customerDrop(drop12);

    expect(node.id).toBe('cust-12-node');
    expect(node.parentId).toBe(drop12.odpId);
    expect(node.meta?.coreNo).toBeGreaterThan(0);

    const after = await splitterOf(drop12.odpId);
    expect(after?.ports.filter((p) => p.outNodeId === null).length).toBe(freeBefore - 1);
    expect(after?.ports.some((p) => p.customerId === 'cust-12')).toBe(true);

    expect((await repo.findCable('cust-12-node-drop'))?.toNodeId).toBe('cust-12-node');
    const [strand] = await db.select().from(strands).where(eq(strands.customerId, 'cust-12'));
    expect(strand?.id).toBe('cust-12-node-strand');
    const [circuit] = await db.select().from(circuits).where(eq(circuits.customerId, 'cust-12'));
    expect(circuit?.oltNodeId).toBe('olt-1');
  });

  it('customerDrop rejects a subscriber already on the map', async () => {
    await repo.ensureSeeded();
    await expect(
      repo.customerDrop({
        ...drop12,
        customerId: 'cust-1',
        customerNodeId: 'cust-1-node',
        metaBase: { customerId: 'cust-1' },
      }),
    ).rejects.toThrow('sudah terpasang');
  });

  it('customerDrop rejects a port that is already taken', async () => {
    await repo.ensureSeeded();
    const s = await splitterOf(drop12.odpId);
    const taken = s?.ports.find((p) => p.outNodeId !== null);
    expect(taken).toBeDefined();
    await expect(repo.customerDrop({ ...drop12, portNo: taken?.portNo })).rejects.toThrow(
      'sudah terpakai',
    );
  });

  it('customerDrop rejects when the ODP splitter is full', async () => {
    await repo.ensureSeeded();
    const odp = await repo.createNode({
      name: 'ODP Penuh',
      type: 'odp',
      status: 'up',
      parentId: 'olt-1-odc-1',
      lat: -6.55,
      lng: 110.68,
      meta: null,
      splitterRatio: '1:2',
    });
    await db
      .update(splitters)
      .set({
        ports: [
          { portNo: 1, outNodeId: 'a-node', customerId: 'a', strandId: null },
          { portNo: 2, outNodeId: 'b-node', customerId: 'b', strandId: null },
        ],
      })
      .where(eq(splitters.nodeId, odp.id));

    await expect(repo.customerDrop({ ...drop12, odpId: odp.id })).rejects.toThrow('penuh');
  });

  it('deleteNode frees the customer drop so the port can be reused', async () => {
    await repo.ensureSeeded();
    await repo.customerDrop(drop12);

    expect(await repo.deleteNode('cust-12-node')).toBe(true);
    expect(await repo.findNode('cust-12-node')).toBeUndefined();
    expect(await repo.findCable('cust-12-node-drop')).toBeUndefined();
    const s = await splitterOf(drop12.odpId);
    expect(s?.ports.some((p) => p.customerId === 'cust-12')).toBe(false);

    // Re-install reuses the freed port cleanly (deterministic ids).
    const reinstalled = await repo.customerDrop(drop12);
    expect(reinstalled.id).toBe('cust-12-node');
  });

  it('deleteNode reparents children to the removed node parent', async () => {
    await repo.ensureSeeded();
    // cust-1-node hangs off this pole; deleting it reparents to the ODP.
    expect(await repo.deleteNode('olt-1-odc-1-odp-1-pole')).toBe(true);
    expect((await repo.findNode('cust-1-node'))?.parentId).toBe('olt-1-odc-1-odp-1');
  });

  it('deleteNode returns false for a missing node', async () => {
    await repo.ensureSeeded();
    expect(await repo.deleteNode('does-not-exist')).toBe(false);
  });

  it('updateNode re-homes a moved customer onto its new serving ODP', async () => {
    await repo.ensureSeeded();
    const oldOdp = 'olt-1-odc-1-odp-1';
    const newOdp = 'olt-2-odc-2-odp-2';

    const node = await repo.updateNode(
      'cust-1-node',
      { parentId: newOdp },
      { ponPort: '0/1/1', onuSerial: 'ZTEG10000001' },
    );

    expect(node.parentId).toBe(newOdp);
    expect(node.meta?.coreNo).toBeGreaterThan(0);
    expect((await splitterOf(oldOdp))?.ports.some((p) => p.customerId === 'cust-1')).toBe(false);
    expect((await splitterOf(newOdp))?.ports.some((p) => p.customerId === 'cust-1')).toBe(true);
    const [circuit] = await db.select().from(circuits).where(eq(circuits.customerId, 'cust-1'));
    expect(circuit?.oltNodeId).toBe('olt-2');
  });

  it('updateNode rejects a re-home onto a full ODP', async () => {
    await repo.ensureSeeded();
    const full = await repo.createNode({
      name: 'ODP Penuh',
      type: 'odp',
      status: 'up',
      parentId: 'olt-1-odc-1',
      lat: -6.55,
      lng: 110.68,
      meta: null,
      splitterRatio: '1:2',
    });
    await db
      .update(splitters)
      .set({
        ports: [
          { portNo: 1, outNodeId: 'a-node', customerId: 'a', strandId: null },
          { portNo: 2, outNodeId: 'b-node', customerId: 'b', strandId: null },
        ],
      })
      .where(eq(splitters.nodeId, full.id));

    await expect(
      repo.updateNode('cust-1-node', { parentId: full.id }, { ponPort: '0/1/1', onuSerial: null }),
    ).rejects.toThrow('tujuan');
  });

  it('updateNode throws when the node is missing', async () => {
    await repo.ensureSeeded();
    await expect(repo.updateNode('nope', { name: 'x' }, null)).rejects.toThrow();
  });

  it('createNode provisions a splitter for a new ODP', async () => {
    await repo.ensureSeeded();
    const node = await repo.createNode({
      name: 'ODP Baru',
      type: 'odp',
      status: 'up',
      parentId: 'olt-1-odc-1',
      lat: -6.55,
      lng: 110.68,
      meta: null,
      splitterRatio: '1:8',
    });
    const s = await splitterOf(node.id);
    expect(s?.ports).toHaveLength(8);
    expect(s?.ratio).toBe('1:8');
  });

  it('updateCableRoute replaces the route and recomputes length', async () => {
    await repo.ensureSeeded();
    const [cable] = await db.select().from(cables);
    expect(cable).toBeDefined();
    const route = [
      { lat: -6.55, lng: 110.68 },
      { lat: -6.56, lng: 110.69 },
    ];
    const updated = await repo.updateCableRoute(cable?.id ?? '', route);
    expect(updated?.route).toEqual(route);
    expect(updated?.lengthM).toBe(routeLength(route));
  });

  it('updateCableRoute returns undefined for a missing cable', async () => {
    await repo.ensureSeeded();
    const updated = await repo.updateCableRoute('no-such-cable', [
      { lat: 0, lng: 0 },
      { lat: 1, lng: 1 },
    ]);
    expect(updated).toBeUndefined();
  });
});
