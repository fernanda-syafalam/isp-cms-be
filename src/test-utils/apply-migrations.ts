import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

/**
 * Applies the REAL `drizzle/*.sql` migrations, in filename order, to a
 * fresh Testcontainer Postgres connection.
 *
 * TEST-H1 (test-infra audit): every `*.int-spec.ts` used to hand-mirror
 * `CREATE TABLE` DDL instead of running the actual migrations. That drifts
 * silently in the dangerous direction — a CHECK constraint, a partial
 * unique index (e.g. `invoices_customer_period_idx WHERE type = 'regular'`,
 * `reseller_ledger_reseller_type_ref_idx`), or a NOT NULL added in a real
 * `drizzle/*.sql` migration is simply omitted from the hand DDL, so the
 * suite passes against a schema that is MORE PERMISSIVE than production.
 *
 * This helper makes the real migrations the single source of truth for the
 * money-critical int-specs: it reads every `.sql` file in `drizzle/`,
 * sorts by filename (the numeric prefix `NNNN_*` is drizzle-kit's own
 * apply order — matches `drizzle/meta/_journal.json`), and runs each file
 * as one `pool.query()` call.
 *
 * Each file is sent as a single multi-statement string with no bind
 * parameters, so `pg` uses the simple query protocol — the same mechanism
 * the pre-existing hand-DDL specs already relied on for their own
 * multi-statement `CREATE TABLE ...; CREATE INDEX ...;` blocks. Each file
 * therefore runs as its own implicit transaction; verified none of the
 * `ALTER TYPE ... ADD VALUE` migrations in this repo also *use* the new
 * enum value in the same file (which is required, since Postgres cannot
 * use an enum value added earlier in the same transaction).
 */
export async function applyMigrations(pool: Pool, migrationsDir?: string): Promise<void> {
  const dir = migrationsDir ?? join(__dirname, '../../drizzle');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf-8');
    await pool.query(sql);
  }
}
