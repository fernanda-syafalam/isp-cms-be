import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import { RedisService } from '../../infrastructure/redis/redis.service';

interface LivenessStatus {
  status: 'ok';
}

type DependencyState = 'ok' | 'down';

interface ReadinessStatus {
  status: 'ok';
  checks: {
    database: DependencyState;
    redis: DependencyState;
  };
}

/**
 * Liveness and readiness endpoints — wired to K8s probes.
 *
 * - `/healthz` (liveness) is intentionally cheap and dependency-free.
 *   K8s kills the pod when this fails; a slow database or Redis must
 *   NOT take all replicas down at once. See v2 doc, Pilar 6.
 * - `/readyz` (readiness) verifies the app can serve traffic by
 *   pinging every external dependency. New dependencies must be added
 *   here as they land.
 */
@Public()
@Controller()
export class HealthController {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly redis: RedisService,
  ) {}

  @Get('healthz')
  @HttpCode(HttpStatus.OK)
  liveness(): LivenessStatus {
    return { status: 'ok' };
  }

  @Get('readyz')
  @HttpCode(HttpStatus.OK)
  async readiness(): Promise<ReadinessStatus> {
    const [databaseOk, redisOk] = await Promise.all([this.drizzle.ping(), this.redis.ping()]);

    if (!databaseOk || !redisOk) {
      // 503 tells K8s to stop routing traffic to this pod, but does
      // not kill it (that would be liveness's job).
      throw new ServiceUnavailableException({
        status: 'degraded',
        checks: {
          database: databaseOk ? 'ok' : 'down',
          redis: redisOk ? 'ok' : 'down',
        },
      });
    }

    return {
      status: 'ok',
      checks: { database: 'ok', redis: 'ok' },
    };
  }
}
