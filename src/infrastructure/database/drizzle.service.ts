import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { WIB_TIMEZONE } from '../../common/utils/wib-date';
import type { AppConfig } from '../../config/configuration';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

/**
 * Wraps the Postgres connection pool and the Drizzle client. The rest
 * of the app talks to the database only through repositories that
 * inject this service — see Pilar 3 ("Service tidak meng-import
 * drizzle atau db langsung").
 */
@Injectable()
export class DrizzleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DrizzleService.name);
  private pool!: Pool;
  // db is assigned in onModuleInit before any consumer reads it.
  public db!: Db;

  constructor(private readonly config: ConfigService<{ app: AppConfig }, true>) {}

  async onModuleInit(): Promise<void> {
    this.pool = new Pool({
      connectionString: this.config.get('app.database.url', { infer: true }),
      max: this.config.get('app.database.poolSize', { infer: true }),
      // TIME-1 layer 2: pin the Postgres SESSION timezone to Asia/Jakarta
      // explicitly, on every physical connection this pool opens. This is
      // a *separate* fix from setting `TZ=Asia/Jakarta` on the container
      // (layer 1, Dockerfile/compose) — the container's TZ only affects
      // the Node process's own clock (`new Date()`), it does NOT change
      // what a managed Postgres server considers `current_date`/`now()` to
      // be, since that is governed by the connection's own session
      // TimeZone setting, not the client's OS. SQL like
      // `invoices.repository.ts`'s `dueDate + graceDays < current_date`
      // (isolir eligibility) was silently evaluating `current_date`
      // against whatever the DB server's own default TimeZone happens to
      // be (UTC on most managed Postgres) — never explicit, never
      // guaranteed to match the business's WIB clock.
      //
      // `options: '-c timezone=...'` is sent as a libpq startup parameter,
      // so it applies to every connection in the pool at connect time —
      // no extra query, no `pool.on('connect', ...)` listener to keep in
      // sync, and it can't be silently skipped if a caller reuses a
      // connection. Verified against a real Postgres 16 container: `SHOW
      // timezone` / `current_setting('TIMEZONE')` both read back
      // 'Asia/Jakarta', and `current_date` reflects the WIB calendar day.
      options: `-c timezone=${WIB_TIMEZONE}`,
      // Send TCP keepalives. The managed Postgres is reached through the
      // Docker Swarm overlay VIP, whose IPVS load balancer silently drops
      // idle TCP flows. Without keepalives node-postgres keeps handing out a
      // now-dead pooled socket and the next query hangs ~15-30s waiting for a
      // TCP timeout (observed as 16s+ logins / hanging /v1/* behind the VIP).
      // Keepalives keep the flow alive and surface a dead peer quickly.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      // Recycle idle connections well under any overlay idle-drop window so a
      // stale socket is closed by us before it can be handed to a request.
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });

    // Verify connection at startup so a misconfiguration fails fast.
    await this.pool.query('select 1');

    this.db = drizzle(this.pool, { schema, logger: false });
    this.logger.log('database pool initialized');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
    this.logger.log('database pool closed');
  }

  /**
   * Lightweight readiness probe. Returns true when the pool can serve
   * a query, false otherwise. Used by HealthController.readiness().
   */
  async ping(): Promise<boolean> {
    try {
      await this.db.execute(sql`select 1`);
      return true;
    } catch (err) {
      this.logger.warn({ err }, 'database ping failed');
      return false;
    }
  }
}
