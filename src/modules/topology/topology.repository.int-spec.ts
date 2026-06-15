import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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
});
