import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
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
        full_name varchar(120) NOT NULL, phone varchar(20) NOT NULL, email varchar(255), user_id uuid UNIQUE,
        address varchar(255) NOT NULL, area_id uuid, area_name varchar(120),
        plan_id uuid NOT NULL REFERENCES plans(id),
        status customer_status NOT NULL DEFAULT 'prospek',
        outstanding integer NOT NULL DEFAULT 0, npwp varchar(40), ktp varchar(32),
        consent_at timestamptz(3), data_deletion_requested_at timestamptz(3),
        reseller_name varchar(120), reseller_id uuid, connection jsonb,
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
        work_order_id uuid,
        at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE INDEX stock_movements_work_order_id_idx ON stock_movements (work_order_id);
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

  describe('listMovements search (q)', () => {
    it('matches by serial substring case-insensitively', async () => {
      const a = await repo.create({ kind: 'onu', serial: 'ZTEG-MOV-001' });
      const b = await repo.create({ kind: 'router', serial: 'TP-LINK-MOV-001' });
      await repo.addMovement({
        itemId: a.id,
        serial: a.serial,
        kind: a.kind,
        type: 'in',
        note: 'Stok masuk',
      });
      await repo.addMovement({
        itemId: b.id,
        serial: b.serial,
        kind: b.kind,
        type: 'in',
        note: 'Stok masuk',
      });

      const result = await repo.listMovements({ q: 'zteg', limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.serial).toBe('ZTEG-MOV-001');
    });

    it('matches by note substring case-insensitively', async () => {
      const a = await repo.create({ kind: 'onu', serial: 'SN-NOTE-001' });
      const b = await repo.create({ kind: 'onu', serial: 'SN-NOTE-002' });
      await repo.addMovement({
        itemId: a.id,
        serial: a.serial,
        kind: a.kind,
        type: 'assign',
        note: 'Budi Santoso',
      });
      await repo.addMovement({
        itemId: b.id,
        serial: b.serial,
        kind: b.kind,
        type: 'in',
        note: 'Stok masuk',
      });

      const result = await repo.listMovements({ q: 'budi', limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.note).toBe('Budi Santoso');
    });

    it('total reflects the q filter, not the full table count', async () => {
      const item = await repo.create({ kind: 'onu', serial: 'SN-TOTAL-001' });
      await repo.addMovement({
        itemId: item.id,
        serial: item.serial,
        kind: item.kind,
        type: 'in',
        note: 'MATCH-NOTE',
      });
      await repo.addMovement({
        itemId: item.id,
        serial: item.serial,
        kind: item.kind,
        type: 'return',
        note: 'OTHER-NOTE',
      });

      const result = await repo.listMovements({ q: 'MATCH-NOTE', limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
    });

    it('returns empty result when q matches nothing', async () => {
      const item = await repo.create({ kind: 'onu', serial: 'SN-EMPTY-001' });
      await repo.addMovement({
        itemId: item.id,
        serial: item.serial,
        kind: item.kind,
        type: 'in',
        note: 'Stok masuk',
      });

      const result = await repo.listMovements({ q: 'doesnotexist', limit: 50, offset: 0 });
      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
    });
  });

  describe('listMovements sort', () => {
    it('sorts by at ascending', async () => {
      const item = await repo.create({ kind: 'onu', serial: 'SN-SORT-001' });
      await repo.addMovement({
        itemId: item.id,
        serial: item.serial,
        kind: item.kind,
        type: 'in',
        note: 'first',
        at: new Date('2026-06-15T01:00:00.000Z'),
      });
      await repo.addMovement({
        itemId: item.id,
        serial: item.serial,
        kind: item.kind,
        type: 'assign',
        note: 'second',
        at: new Date('2026-06-15T03:00:00.000Z'),
      });
      await repo.addMovement({
        itemId: item.id,
        serial: item.serial,
        kind: item.kind,
        type: 'return',
        note: 'third',
        at: new Date('2026-06-15T02:00:00.000Z'),
      });

      const result = await repo.listMovements({ sort: 'at', order: 'asc', limit: 50, offset: 0 });
      expect(result.items.map((m) => m.note)).toEqual(['first', 'third', 'second']);
    });

    it('sorts by at descending (default behaviour)', async () => {
      const item = await repo.create({ kind: 'onu', serial: 'SN-SORT-002' });
      await repo.addMovement({
        itemId: item.id,
        serial: item.serial,
        kind: item.kind,
        type: 'in',
        note: 'first',
        at: new Date('2026-06-15T01:00:00.000Z'),
      });
      await repo.addMovement({
        itemId: item.id,
        serial: item.serial,
        kind: item.kind,
        type: 'assign',
        note: 'second',
        at: new Date('2026-06-15T02:00:00.000Z'),
      });

      const result = await repo.listMovements({ sort: 'at', order: 'desc', limit: 50, offset: 0 });
      expect(result.items.map((m) => m.note)).toEqual(['second', 'first']);
    });

    it('sorts by serial ascending', async () => {
      const a = await repo.create({ kind: 'onu', serial: 'CCC-SORT-003' });
      const b = await repo.create({ kind: 'onu', serial: 'AAA-SORT-001' });
      const c = await repo.create({ kind: 'router', serial: 'BBB-SORT-002' });
      await repo.addMovement({
        itemId: a.id,
        serial: a.serial,
        kind: a.kind,
        type: 'in',
        note: 'n',
      });
      await repo.addMovement({
        itemId: b.id,
        serial: b.serial,
        kind: b.kind,
        type: 'in',
        note: 'n',
      });
      await repo.addMovement({
        itemId: c.id,
        serial: c.serial,
        kind: c.kind,
        type: 'in',
        note: 'n',
      });

      const result = await repo.listMovements({
        sort: 'serial',
        order: 'asc',
        limit: 50,
        offset: 0,
      });
      expect(result.items.map((m) => m.serial)).toEqual([
        'AAA-SORT-001',
        'BBB-SORT-002',
        'CCC-SORT-003',
      ]);
    });

    it('falls back to at desc when sort key is unknown', async () => {
      const item = await repo.create({ kind: 'onu', serial: 'SN-FALLBACK-001' });
      await repo.addMovement({
        itemId: item.id,
        serial: item.serial,
        kind: item.kind,
        type: 'in',
        note: 'older',
        at: new Date('2026-06-15T01:00:00.000Z'),
      });
      await repo.addMovement({
        itemId: item.id,
        serial: item.serial,
        kind: item.kind,
        type: 'assign',
        note: 'newer',
        at: new Date('2026-06-15T02:00:00.000Z'),
      });

      // Unknown sort key → falls back to at desc → newer first
      const result = await repo.listMovements({
        sort: 'notAColumn',
        order: 'asc',
        limit: 50,
        offset: 0,
      });
      expect(result.items.map((m) => m.note)).toEqual(['newer', 'older']);
    });
  });

  describe('search (q)', () => {
    it('matches by serial substring case-insensitively', async () => {
      await repo.create({ kind: 'onu', serial: 'ZTEG-ABC-001' });
      await repo.create({ kind: 'onu', serial: 'ZTEG-XYZ-002' });
      await repo.create({ kind: 'router', serial: 'TP-LINK-001' });

      const result = await repo.list({ q: 'zteg', limit: 50, offset: 0 });
      expect(result.total).toBe(2);
      expect(result.items.map((i) => i.serial).sort()).toEqual(['ZTEG-ABC-001', 'ZTEG-XYZ-002']);
    });

    it('matches by assignedTo (customer name) case-insensitively', async () => {
      const a = await repo.create({ kind: 'onu', serial: 'SN-BUDI-1' });
      const b = await repo.create({ kind: 'onu', serial: 'SN-BUDI-2' });
      await repo.create({ kind: 'router', serial: 'SN-OTHER-1' });

      await repo.update(a.id, { status: 'installed', assignedTo: 'Budi Santoso' });
      await repo.update(b.id, { status: 'installed', assignedTo: 'Budi Prasetyo' });

      const result = await repo.list({ q: 'budi', limit: 50, offset: 0 });
      expect(result.total).toBe(2);
      expect(result.items.every((i) => i.assignedTo?.toLowerCase().includes('budi'))).toBe(true);
    });

    it('total reflects the q filter, not the full table count', async () => {
      await repo.create({ kind: 'onu', serial: 'MATCH-001' });
      await repo.create({ kind: 'onu', serial: 'MATCH-002' });
      await repo.create({ kind: 'router', serial: 'OTHER-001' });

      const result = await repo.list({ q: 'MATCH', limit: 50, offset: 0 });
      // total must equal only the 2 matching rows, even though 3 exist
      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
    });

    it('returns empty result when q matches nothing', async () => {
      await repo.create({ kind: 'onu', serial: 'SN-001' });

      const result = await repo.list({ q: 'doesnotexist', limit: 50, offset: 0 });
      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
    });
  });

  describe('sort', () => {
    it('sorts by serial ascending', async () => {
      await repo.create({ kind: 'onu', serial: 'CCC-003' });
      await repo.create({ kind: 'onu', serial: 'AAA-001' });
      await repo.create({ kind: 'router', serial: 'BBB-002' });

      const result = await repo.list({ sort: 'serial', order: 'asc', limit: 50, offset: 0 });
      expect(result.items.map((i) => i.serial)).toEqual(['AAA-001', 'BBB-002', 'CCC-003']);
    });

    it('sorts by serial descending', async () => {
      await repo.create({ kind: 'onu', serial: 'CCC-003' });
      await repo.create({ kind: 'onu', serial: 'AAA-001' });
      await repo.create({ kind: 'router', serial: 'BBB-002' });

      const result = await repo.list({ sort: 'serial', order: 'desc', limit: 50, offset: 0 });
      expect(result.items.map((i) => i.serial)).toEqual(['CCC-003', 'BBB-002', 'AAA-001']);
    });

    it('falls back to createdAt desc when sort key is unknown', async () => {
      // Insert in order: X, Y, Z — default sort is createdAt desc so Z is first
      const x = await repo.create({ kind: 'onu', serial: 'X-001' });
      const y = await repo.create({ kind: 'onu', serial: 'Y-002' });
      const z = await repo.create({ kind: 'onu', serial: 'Z-003' });

      // created_at is timestamptz(3); back-to-back inserts can tie at ms
      // precision, so pin distinct timestamps to make the order observable
      const base = new Date('2026-01-01T00:00:00Z');
      await db
        .update(inventoryItems)
        .set({ createdAt: new Date(base.getTime()) })
        .where(eq(inventoryItems.id, x.id));
      await db
        .update(inventoryItems)
        .set({ createdAt: new Date(base.getTime() + 1000) })
        .where(eq(inventoryItems.id, y.id));
      await db
        .update(inventoryItems)
        .set({ createdAt: new Date(base.getTime() + 2000) })
        .where(eq(inventoryItems.id, z.id));

      const result = await repo.list({ sort: 'notAColumn', order: 'asc', limit: 50, offset: 0 });
      // Default: createdAt desc → Z, Y, X
      expect(result.items.map((i) => i.id)).toEqual([z.id, y.id, x.id]);
    });
  });
});
