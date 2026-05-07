// MUST be the very first import — auto-instrumentation patches
// modules at load time. Same rationale as in main.ts.
import './observability/tracing';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module';

/**
 * Worker process bootstrap. Runs forever; BullMQ's worker objects
 * (registered via `@Processor` in EmailProcessor and friends) take
 * over from here.
 *
 * Deploy as a separate Deployment in K8s, scaled by queue depth (KEDA
 * or a custom HPA) — see Pilar 7. The container image is the same
 * multi-stage Dockerfile, with `CMD ["dist/worker.js"]` instead of
 * the API's `dist/main.js`.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.get(Logger).log('worker started');
}

void bootstrap();
