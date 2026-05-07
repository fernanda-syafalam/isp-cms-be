import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';

interface HealthStatus {
  status: 'ok';
}

/**
 * Liveness and readiness endpoints — wired to K8s probes.
 *
 * - `/healthz` (liveness) must be cheap and dependency-free. K8s kills
 *   the pod when this fails, so a slow database must NOT take all
 *   replicas down. Per v2 Best Practices doc, Pilar 6.
 * - `/readyz` (readiness) is where dependency checks belong (DB, Redis).
 *   Today it is a placeholder; real indicators will be added once the
 *   infrastructure modules land (Drizzle, Redis).
 */
@Controller()
export class HealthController {
  @Get('healthz')
  @HttpCode(HttpStatus.OK)
  liveness(): HealthStatus {
    return { status: 'ok' };
  }

  @Get('readyz')
  @HttpCode(HttpStatus.OK)
  readiness(): HealthStatus {
    // TODO: wire dependency checks here (DrizzleHealthIndicator,
    // RedisHealthIndicator) once those infrastructure modules exist.
    // See v2 Best Practices doc, Pilar 6, "Health check dengan
    // @nestjs/terminus".
    return { status: 'ok' };
  }
}
