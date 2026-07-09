import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
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
