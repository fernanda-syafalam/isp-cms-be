import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';

interface LivenessStatus {
  status: 'ok';
}

interface ReadinessStatus {
  status: 'ok';
  checks: {
    database: 'ok';
  };
}

/**
 * Liveness and readiness endpoints — wired to K8s probes.
 *
 * - `/healthz` (liveness) is intentionally cheap and dependency-free.
 *   K8s kills the pod when this fails; a slow database must NOT take
 *   all replicas down at once. See v2 doc, Pilar 6.
 * - `/readyz` (readiness) verifies the app can serve traffic by
 *   pinging every external dependency. Today only Postgres is wired;
 *   Redis and any future critical dependency must be added here as
 *   they land.
 */
@Controller()
export class HealthController {
  constructor(private readonly drizzle: DrizzleService) {}

  @Get('healthz')
  @HttpCode(HttpStatus.OK)
  liveness(): LivenessStatus {
    return { status: 'ok' };
  }

  @Get('readyz')
  @HttpCode(HttpStatus.OK)
  async readiness(): Promise<ReadinessStatus> {
    const databaseOk = await this.drizzle.ping();
    if (!databaseOk) {
      // 503 tells K8s to stop routing traffic to this pod, but does
      // not kill it (that would be liveness's job).
      throw new ServiceUnavailableException({
        status: 'degraded',
        checks: { database: 'down' },
      });
    }

    return {
      status: 'ok',
      checks: { database: 'ok' },
    };
  }
}
