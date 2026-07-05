import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import {
  type NewPaymentIntent,
  invoices,
  paymentIntents,
} from '../../infrastructure/database/schema/invoices.schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';
import { PaymentIntentsRepository } from './payment-intents.repository';

/**
 * Real Postgres integration test for PaymentIntentsRepository. Requires
 * Docker. Schema applied by hand (mirroring migrations 0002-0004 + 0025).
 */
describe('PaymentIntentsRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: PaymentIntentsRepository;
  let invoiceId: string;

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
      CREATE TYPE customer_hold_reason AS ENUM ('overdue', 'voluntary');
      CREATE SEQUENCE customer_no_seq START WITH 9001;
      CREATE TABLE customers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_no varchar(32) NOT NULL UNIQUE DEFAULT ('CUST-' || nextval('customer_no_seq')),
        full_name varchar(120) NOT NULL, phone varchar(20) NOT NULL, email varchar(255), user_id uuid UNIQUE,
        address varchar(255) NOT NULL, area_id uuid, area_name varchar(120),
        plan_id uuid NOT NULL REFERENCES plans(id),
        status customer_status NOT NULL DEFAULT 'prospek', hold_reason customer_hold_reason,
        outstanding integer NOT NULL DEFAULT 0, npwp varchar(40), ktp varchar(32),
        consent_at timestamptz(3), data_deletion_requested_at timestamptz(3),
        reseller_name varchar(120), reseller_id uuid, connection jsonb,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TYPE invoice_status AS ENUM ('draft', 'pending', 'overdue', 'paid');
      CREATE SEQUENCE invoice_no_seq START WITH 100;
      CREATE TABLE invoices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        invoice_no varchar(32) NOT NULL UNIQUE
          DEFAULT ('INV-' || to_char(now(), 'YYYY') || '-' || nextval('invoice_no_seq')),
        customer_id uuid NOT NULL REFERENCES customers(id),
        customer_name varchar(120) NOT NULL,
        period_start date NOT NULL, period_end date NOT NULL,
        amount integer NOT NULL, late_fee integer NOT NULL DEFAULT 0,
        tax_amount integer NOT NULL DEFAULT 0, tax_invoice_no varchar(40),
        status invoice_status NOT NULL DEFAULT 'pending', due_date date NOT NULL,
        paid_at timestamptz(3), last_reminded_at timestamptz(3),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TYPE payment_channel AS ENUM
        ('qris', 'va_bca', 'va_mandiri', 'va_bri', 'va_bni', 'gopay', 'ovo', 'dana', 'shopeepay');
      CREATE TYPE payment_intent_status AS ENUM ('pending', 'paid', 'expired');
      CREATE TABLE payment_intents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        invoice_id uuid NOT NULL REFERENCES invoices(id),
        invoice_no varchar(32) NOT NULL,
        customer_name varchar(120) NOT NULL,
        amount integer NOT NULL,
        channel payment_channel NOT NULL,
        status payment_intent_status NOT NULL DEFAULT 'pending',
        va_number varchar(40), qr_payload varchar(512),
        expires_at timestamptz(3) NOT NULL,
        paid_at timestamptz(3),
        created_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE INDEX payment_intents_invoice_id_idx ON payment_intents (invoice_id);
    `);

    const [plan] = await db
      .insert(plans)
      .values({ name: 'Home 50', speedMbps: 50, priceMonthly: 200_000 })
      .returning();
    if (!plan) throw new Error('plan seed missing');
    const [customer] = await db
      .insert(customers)
      .values({ fullName: 'Budi Santoso', phone: '0811', address: 'Jl. Mawar', planId: plan.id })
      .returning();
    if (!customer) throw new Error('customer seed missing');
    const [invoice] = await db
      .insert(invoices)
      .values({
        customerId: customer.id,
        customerName: customer.fullName,
        periodStart: '2026-06-01',
        periodEnd: '2026-06-30',
        amount: 200_000,
        taxAmount: 22_000,
        dueDate: '2026-06-10',
      })
      .returning();
    if (!invoice) throw new Error('invoice seed missing');
    invoiceId = invoice.id;

    repo = new PaymentIntentsRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(paymentIntents);
  });

  const pending = (over: Partial<NewPaymentIntent> = {}): NewPaymentIntent => ({
    invoiceId,
    invoiceNo: 'INV-2026-100',
    customerName: 'Budi Santoso',
    amount: 222_000,
    channel: 'qris',
    qrPayload: 'ID.MOCK.QRIS|qris|INV-2026-100|222000',
    expiresAt: new Date('2026-06-17T00:00:00.000Z'),
    ...over,
  });

  it('creates an intent and reads it back with its rails preserved', async () => {
    const created = await repo.create(
      pending({ channel: 'va_bca', qrPayload: null, vaNumber: '8808123' }),
    );
    const found = await repo.findById(created.id);
    expect(found?.channel).toBe('va_bca');
    expect(found?.vaNumber).toBe('8808123');
    expect(found?.qrPayload).toBeNull();
    expect(found?.status).toBe('pending');
    expect(found?.expiresAt).toBeInstanceOf(Date);
  });

  it('returns null for an unknown intent', async () => {
    expect(await repo.findById('00000000-0000-0000-0000-0000000000ff')).toBeNull();
  });

  it('marks an intent paid with a paidAt timestamp', async () => {
    const created = await repo.create(pending());
    const paid = await repo.markPaid(created.id);
    expect(paid.status).toBe('paid');
    expect(paid.paidAt).toBeInstanceOf(Date);
  });

  it('rejects marking an unknown intent paid', async () => {
    await expect(repo.markPaid('00000000-0000-0000-0000-0000000000ff')).rejects.toThrow();
  });

  it('marks an intent expired', async () => {
    const created = await repo.create(pending());
    await repo.markExpired(created.id);
    const found = await repo.findById(created.id);
    expect(found?.status).toBe('expired');
  });

  it('expireStalePending only expires pending intents past their window', async () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    const stale = await repo.create(pending({ expiresAt: new Date('2026-06-19T00:00:00.000Z') }));
    const fresh = await repo.create(pending({ expiresAt: new Date('2026-06-21T00:00:00.000Z') }));
    const alreadyPaid = await repo.create(
      pending({ expiresAt: new Date('2026-06-18T00:00:00.000Z') }),
    );
    await repo.markPaid(alreadyPaid.id);

    const expired = await repo.expireStalePending(now);

    expect(expired).toBe(1);
    expect((await repo.findById(stale.id))?.status).toBe('expired');
    expect((await repo.findById(fresh.id))?.status).toBe('pending');
    expect((await repo.findById(alreadyPaid.id))?.status).toBe('paid');
  });
});
