// MUST be imported before any NestJS / Node module that should be
// instrumented — auto-instrumentation patches modules at load time.
// See src/observability/tracing.ts. Common Pitfall #19 in the v2 doc.
import './observability/tracing';

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Disable Fastify's built-in logger; nestjs-pino owns logging.
      logger: false,
      // Required when running behind an ingress / load balancer in K8s.
      trustProxy: true,
      // Default 1 MB body limit; raise explicitly per route if needed.
      bodyLimit: 1_048_576,
      genReqId: (req: IncomingMessage | Http2ServerRequest) =>
        req.headers['x-request-id']?.toString() ?? randomUUID(),
    }),
    // Buffer log lines until `useLogger` swaps the default Nest logger
    // for pino — without this the bootstrap lines come out as plain
    // text and are hard to grep alongside JSON request logs.
    { bufferLogs: true },
  );

  // Hand request logging and bootstrap logs to pino.
  app.useLogger(app.get(Logger));

  // URI versioning so business endpoints live under /v1, /v2, etc.
  // Health endpoints stay un-versioned (no `version` on the controller).
  app.enableVersioning({ type: VersioningType.URI });

  // Required so SIGTERM in K8s triggers OnModuleDestroy hooks.
  app.enableShutdownHooks();

  // Read port via ConfigService so the value comes from the validated
  // env schema (parsed + coerced), not an ad-hoc process.env read.
  const config = app.get(ConfigService<{ app: AppConfig }, true>);
  const port = config.get('app.port', { infer: true });
  // Bind to 0.0.0.0 — without this, the container is unreachable from outside the pod.
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
