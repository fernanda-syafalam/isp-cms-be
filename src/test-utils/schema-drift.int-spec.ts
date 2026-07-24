import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from './apply-migrations';

/**
 * TEST-H1 drift guard. Applies the REAL `drizzle/*.sql` migrations to a
 * fresh Testcontainer and asserts the money-critical constraints/indexes
 * are actually present in the resulting schema.
 *
 * Most `*.int-spec.ts` files in this repo still hand-mirror `CREATE TABLE`
 * DDL instead of running the real migrations (converting all of them is a
 * bigger follow-up — see the PR that introduced this file for which ones
 * were converted). A hand-DDL suite can drift silently MORE PERMISSIVE
 * than production: a CHECK constraint, a partial unique index, or a NOT
 * NULL added in a real migration can be simply forgotten in the hand DDL,
 * and every hand-DDL spec stays green forever because it never sees the
 * real constraint.
 *
 * This test is the cheap backstop: it doesn't replace converting a given
 * spec to `applyMigrations`, but it catches the dangerous case — a real
 * migration silently dropping/weakening one of the invariants below — even
 * for specs still on hand-DDL, because it queries the REAL applied schema
 * directly via `pg_indexes` / `information_schema`.
 */
describe('schema drift guard — real migrations produce the expected money-critical schema', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await applyMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  async function indexDef(indexName: string): Promise<string | null> {
    const { rows } = await pool.query<{ indexdef: string }>(
      'select indexdef from pg_indexes where indexname = $1',
      [indexName],
    );
    return rows[0]?.indexdef ?? null;
  }

  async function isNotNull(table: string, column: string): Promise<boolean> {
    const { rows } = await pool.query<{ is_nullable: string }>(
      'select is_nullable from information_schema.columns where table_name = $1 and column_name = $2',
      [table, column],
    );
    if (rows.length === 0) {
      throw new Error(`column ${table}.${column} not found in the migrated schema`);
    }
    return rows[0]?.is_nullable === 'NO';
  }

  async function numericPrecisionScale(
    table: string,
    column: string,
  ): Promise<{ dataType: string; precision: number | null; scale: number | null }> {
    const { rows } = await pool.query<{
      data_type: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
    }>(
      `select data_type, numeric_precision, numeric_scale
       from information_schema.columns
       where table_name = $1 and column_name = $2`,
      [table, column],
    );
    if (rows.length === 0) {
      throw new Error(`column ${table}.${column} not found in the migrated schema`);
    }
    return {
      dataType: rows[0]?.data_type as string,
      precision: rows[0]?.numeric_precision ?? null,
      scale: rows[0]?.numeric_scale ?? null,
    };
  }

  async function hasForeignKey(table: string, column: string, refTable: string): Promise<boolean> {
    const { rows } = await pool.query<{ count: string }>(
      `
      select count(*)::text as count
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
      join information_schema.constraint_column_usage ccu
        on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
      where tc.constraint_type = 'FOREIGN KEY'
        and tc.table_name = $1
        and kcu.column_name = $2
        and ccu.table_name = $3
      `,
      [table, column, refTable],
    );
    return Number(rows[0]?.count ?? 0) > 0;
  }

  describe('money idempotency: partial unique indexes', () => {
    // The "one regular invoice per customer per billing period" invariant —
    // InvoicesService.run()/generateFirstInvoice() rely on this to be
    // naturally idempotent on a re-run, not on application-level locking.
    it("invoices_customer_period_idx is a UNIQUE index on (customer_id, period_start) WHERE type = 'regular'", async () => {
      const def = await indexDef('invoices_customer_period_idx');
      expect(def).not.toBeNull();
      expect(def).toContain('UNIQUE INDEX');
      expect(def).toContain('customer_id');
      expect(def).toContain('period_start');
      expect(def).toMatch(/WHERE.*type.*=.*'regular'/);
    });

    // The commission/withdrawal idempotency backstop (P3.D.1) — even if the
    // in-process "does this ref already exist" check ever raced, this index
    // is what actually rejects a second (reseller, type, ref) row.
    it('reseller_ledger_reseller_type_ref_idx is a UNIQUE index on (reseller_id, type, ref) WHERE ref IS NOT NULL', async () => {
      const def = await indexDef('reseller_ledger_reseller_type_ref_idx');
      expect(def).not.toBeNull();
      expect(def).toContain('UNIQUE INDEX');
      expect(def).toContain('reseller_id');
      expect(def).toContain('ref');
      expect(def).toMatch(/WHERE.*ref.*IS NOT NULL/);
    });
  });

  describe('money-path NOT NULL invariants', () => {
    it('invoices.customer_id / amount / due_date are NOT NULL', async () => {
      expect(await isNotNull('invoices', 'customer_id')).toBe(true);
      expect(await isNotNull('invoices', 'amount')).toBe(true);
      expect(await isNotNull('invoices', 'due_date')).toBe(true);
    });

    it('payments.amount is NOT NULL', async () => {
      expect(await isNotNull('payments', 'amount')).toBe(true);
    });

    it('customers.plan_id is NOT NULL', async () => {
      expect(await isNotNull('customers', 'plan_id')).toBe(true);
    });

    it('vouchers.code / price_idr are NOT NULL', async () => {
      expect(await isNotNull('vouchers', 'code')).toBe(true);
      expect(await isNotNull('vouchers', 'price_idr')).toBe(true);
    });

    it('reseller_ledger.reseller_id / amount / balance_after are NOT NULL', async () => {
      expect(await isNotNull('reseller_ledger', 'reseller_id')).toBe(true);
      expect(await isNotNull('reseller_ledger', 'amount')).toBe(true);
      expect(await isNotNull('reseller_ledger', 'balance_after')).toBe(true);
    });
  });

  describe('DB-4: money-adjacent rate columns are exact numeric, not float4', () => {
    // Both columns multiply straight into a rupiah amount
    // (invoices.service.ts `ppnOf` / `postResellerCommission`) — `real`
    // (float4, ~7 significant digits) risked off-by-one-rupiah error at
    // boundary rounding. Migration 0054 moved both to `numeric(6, 5)`.
    it('app_settings.tax_ppn_rate is numeric(6, 5)', async () => {
      const { dataType, precision, scale } = await numericPrecisionScale(
        'app_settings',
        'tax_ppn_rate',
      );
      expect(dataType).toBe('numeric');
      expect(precision).toBe(6);
      expect(scale).toBe(5);
    });

    it('resellers.commission_pct is numeric(6, 5)', async () => {
      const { dataType, precision, scale } = await numericPrecisionScale(
        'resellers',
        'commission_pct',
      );
      expect(dataType).toBe('numeric');
      expect(precision).toBe(6);
      expect(scale).toBe(5);
    });
  });

  describe('money-path foreign keys', () => {
    it('invoices.customer_id -> customers.id', async () => {
      expect(await hasForeignKey('invoices', 'customer_id', 'customers')).toBe(true);
    });

    it('payments.invoice_id -> invoices.id and payments.voucher_id -> vouchers.id', async () => {
      expect(await hasForeignKey('payments', 'invoice_id', 'invoices')).toBe(true);
      expect(await hasForeignKey('payments', 'voucher_id', 'vouchers')).toBe(true);
    });

    // TEST-H1 real finding (see sla-credits.repository.int-spec.ts): these
    // two FKs are exactly what the old hand-DDL suite omitted, letting it
    // use arbitrary fake customer/invoice ids that resolve to no row.
    it('sla_credits.customer_id -> customers.id and applied_invoice_id -> invoices.id', async () => {
      expect(await hasForeignKey('sla_credits', 'customer_id', 'customers')).toBe(true);
      expect(await hasForeignKey('sla_credits', 'applied_invoice_id', 'invoices')).toBe(true);
    });

    it('reseller_ledger.reseller_id -> resellers.id', async () => {
      expect(await hasForeignKey('reseller_ledger', 'reseller_id', 'resellers')).toBe(true);
    });

    it('reseller_payouts.reseller_id -> resellers.id and ledger_entry_id -> reseller_ledger.id', async () => {
      expect(await hasForeignKey('reseller_payouts', 'reseller_id', 'resellers')).toBe(true);
      expect(await hasForeignKey('reseller_payouts', 'ledger_entry_id', 'reseller_ledger')).toBe(
        true,
      );
    });
  });
});
