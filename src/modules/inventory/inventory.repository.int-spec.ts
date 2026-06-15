import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import {
  inventoryItems,
  stockMovements,
} from '../../infrastructure/database/schema/inventory.schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';
import { InventoryRepository } from './inventory.repository';

/**
 * Real Postgres integration test for InventoryRepository. Requires Docker.
 * Schema applied by hand (mirroring migration 0008).
 */
describe('InventoryRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: InventoryRepository;
  let customerId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE plan_status AS ENUM ('active', 'archived');
      CREATE TABLE plans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(80) NOT NULL, speed_mbps integer NOT NULL,
        price_monthly integer NOT NULL, status plan_status NOT NULL DEFAULT 'active',
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TYPE customer_status AS ENUM ('prospek', 'instalasi', 'aktif', 'isolir', 'berhenti');
      CREATE SEQUENCE customer_no_seq START WITH 9001;
      CREATE TABLE customers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_no varchar(32) NOT NULL UNIQUE DEFAULT ('CUST-' || nextval('customer_no_seq')),
        full_name varchar(120) NOT NULL, phone varchar(20) NOT NULL, email varchar(255),
        address varchar(255) NOT NULL, area_id uuid, area_name varchar(120),
        plan_id uuid NOT NULL REFERENCES plans(id),
        status customer_status NOT NULL DEFAULT 'prospek',
        outstanding integer NOT NULL DEFAULT 0, npwp varchar(40), ktp varchar(32),
        consent_at timestamptz(3), data_deletion_requested_at timestamptz(3),
        reseller_name varchar(120), connection jsonb,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TYPE inventory_kind AS ENUM ('onu', 'router', 'mikrotik');
      CREATE TYPE inventory_status AS ENUM ('warehouse', 'installed', 'broken');
      CREATE TYPE stock_movement_type AS ENUM ('in', 'assign', 'return', 'broken');
      CREATE TABLE inventory_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind inventory_kind NOT NULL,
        serial varchar(80) NOT NULL UNIQUE,
        status inventory_status NOT NULL DEFAULT 'warehouse',
        assigned_to varchar(120),
        assigned_customer_id uuid REFERENCES customers(id),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TABLE stock_movements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        item_id uuid NOT NULL REFERENCES inventory_items(id),
        serial varchar(80) NOT NULL, kind inventory_kind NOT NULL,
        type stock_movement_type NOT NULL, note varchar(255) NOT NULL,
        at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    const [plan] = await db
      .insert(plans)
      .values({ name: 'Home 20', speedMbps: 20, priceMonthly: 200_000 })
      .returning();
    if (!plan) throw new Error('plan seed failed');
    const [customer] = await db
      .insert(customers)
      .values({ fullName: 'Budi', phone: '0811', address: 'Jl. A', planId: plan.id })
      .returning();
    if (!customer) throw new Error('customer seed failed');
    customerId = customer.id;

    repo = new InventoryRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(stockMovements);
    await db.delete(inventoryItems);
  });

  it('creates an item defaulting to warehouse and rejects a duplicate serial', async () => {
    const made = await repo.create({ kind: 'onu', serial: 'ZTEG1' });
    expect(made.status).toBe('warehouse');
    await expect(repo.create({ kind: 'onu', serial: 'ZTEG1' })).rejects.toThrow();
  });

  it('lists by status with a real total and limit/offset', async () => {
    await repo.create({ kind: 'onu', serial: 'A' });
    await repo.create({ kind: 'onu', serial: 'B', status: 'installed' });
    await repo.create({ kind: 'router', serial: 'C', status: 'installed' });

    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(3);

    const installed = await repo.list({ status: 'installed', limit: 50, offset: 0 });
    expect(installed.total).toBe(2);

    const page = await repo.list({ limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it('updates fields including the customer FK and deletes', async () => {
    const made = await repo.create({ kind: 'onu', serial: 'X1' });
    const updated = await repo.update(made.id, {
      status: 'installed',
      assignedTo: 'Budi',
      assignedCustomerId: customerId,
    });
    expect(updated.status).toBe('installed');
    expect(updated.assignedCustomerId).toBe(customerId);

    await repo.remove(made.id);
    expect(await repo.findById(made.id)).toBeNull();
    await expect(repo.remove('00000000-0000-0000-0000-0000000000ff')).rejects.toThrow();
  });

  it('appends movements and lists them newest-first', async () => {
    const made = await repo.create({ kind: 'onu', serial: 'M1' });
    await repo.addMovement({
      itemId: made.id,
      serial: made.serial,
      kind: made.kind,
      type: 'in',
      note: 'Stok masuk',
      at: new Date('2026-06-15T01:00:00.000Z'),
    });
    await repo.addMovement({
      itemId: made.id,
      serial: made.serial,
      kind: made.kind,
      type: 'assign',
      note: 'Budi',
      at: new Date('2026-06-15T02:00:00.000Z'),
    });

    const ledger = await repo.listMovements({ limit: 50, offset: 0 });
    expect(ledger.total).toBe(2);
    expect(ledger.items.map((m) => m.type)).toEqual(['assign', 'in']);
  });
});
