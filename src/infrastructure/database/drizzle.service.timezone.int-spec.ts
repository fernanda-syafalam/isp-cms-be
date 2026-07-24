import type { ConfigService } from '@nestjs/config';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WIB_TIMEZONE } from '../../common/utils/wib-date';
import type { AppConfig } from '../../config/configuration';
import { DrizzleService } from './drizzle.service';

/**
 * TIME-1 regression guard, layer 2 (Postgres session timezone).
 *
 * Setting `TZ=Asia/Jakarta` on the container (layer 1, Dockerfile /
 * docker-compose) only changes what the NODE process's own clock thinks
 * "now" is. It does nothing to a remote Postgres server's own idea of
 * `current_date`/`now()` — that is governed purely by the connection's
 * session `TimeZone` setting, which defaults to the DB server's own
 * default (typically UTC on a managed Postgres) unless the client sets it
 * explicitly. `invoices.repository.ts`'s overdue/grace/isolir SQL
 * (`current_date`, `now()`) depends on this being WIB, not UTC — this
 * spec asserts `DrizzleService` actually pins it, against a REAL Postgres
 * (Testcontainers), so a regression (e.g. someone drops the `options`
 * line, or a connection-pooling change bypasses it) is caught here rather
 * than surfacing as a silent one-day billing/isolir drift in production.
 */
describe('DrizzleService (integration) — Postgres session timezone (TIME-1)', () => {
  let container: StartedPostgreSqlContainer;
  let service: DrizzleService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    // A minimal fake ConfigService exposing only the two keys
    // DrizzleService.onModuleInit reads — same shape used elsewhere in
    // this suite for narrow collaborator fakes (e.g. invoices.repository
    // int-spec's `{ db } as unknown as DrizzleService`).
    const fakeConfig = {
      get: (key: string) => {
        if (key === 'app.database.url') return container.getConnectionUri();
        if (key === 'app.database.poolSize') return 5;
        throw new Error(`unexpected config key in test: ${key}`);
      },
    } as unknown as ConfigService<{ app: AppConfig }, true>;

    service = new DrizzleService(fakeConfig);
    await service.onModuleInit();
  }, 60_000);

  afterAll(async () => {
    await service.onModuleDestroy();
    await container.stop();
  });

  it(`the pooled connection's session timezone is ${WIB_TIMEZONE}, not the Postgres server default`, async () => {
    const result = await service.db.execute<{ TimeZone: string }>(sql`show timezone`);
    expect(result.rows[0]?.TimeZone).toBe(WIB_TIMEZONE);
  });

  it("current_setting('TIMEZONE') agrees", async () => {
    const result = await service.db.execute<{ tz: string }>(
      sql`select current_setting('TIMEZONE') as tz`,
    );
    expect(result.rows[0]?.tz).toBe(WIB_TIMEZONE);
  });

  it('casting a timestamptz to date rolls over at WIB midnight, not UTC midnight — the exact mechanism invoices.repository.ts relies on for current_date comparisons', async () => {
    // Deterministic proof rather than a flaky "depends on when the test
    // runs" check: 2026-07-23T17:00:00Z is 2026-07-24T00:00:00+07:00 — the
    // WIB calendar day has already rolled over even though the UTC day
    // hasn't. Postgres interprets a timestamptz -> date cast (and
    // `current_date`) through the session's own TimeZone, which
    // DrizzleService pins to Asia/Jakarta — so this must read '2026-07-24'.
    //
    // to_char(..., text) rather than a bare `::date` select: node-postgres's
    // default type parser for the `date` OID rebuilds a JS `Date` using the
    // CLIENT's own local timezone (a separate, unrelated pg-node quirk from
    // TIME-1), which would make the raw value ambiguous here. Forcing text
    // output sidesteps that entirely and keeps this assertion a plain
    // calendar-date string, independent of the test runner's own TZ.
    const result = await service.db.execute<{ wib_date: string }>(
      sql`select to_char((timestamptz '2026-07-23 17:00:00+00'), 'YYYY-MM-DD') as wib_date`,
    );
    expect(result.rows[0]?.wib_date).toBe('2026-07-24');
  });
});
