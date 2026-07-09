// MUST be imported before any NestJS / Node module that should be
// instrumented — auto-instrumentation patches modules at load time.
// See src/observability/tracing.ts. Common Pitfall #19 in the v2 doc.
import './observability/tracing';

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
import fastifyCookie from '@fastify/cookie';
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
    {
      // Buffer log lines until `useLogger` swaps the default Nest logger
      // for pino — without this the bootstrap lines come out as plain
      // text and are hard to grep alongside JSON request logs.
      bufferLogs: true,
      // Preserves the exact request bytes on `req.rawBody` alongside the
      // normal parsed `req.body` (ADR-0016) — the Tripay webhook signature
      // must be verified over the raw bytes Tripay actually signed, not a
      // re-serialized JSON.parse(body) that could diverge (key order,
      // whitespace). Global (not per-route) is the only way NestJS exposes
      // this; the extra buffered Buffer per request is negligible next to
      // the existing 1 MB bodyLimit above.
      rawBody: true,
    },
  );

  // Hand request logging and bootstrap logs to pino.
  app.useLogger(app.get(Logger));

  // URI versioning so business endpoints live under /v1, /v2, etc.
  // Health endpoints stay un-versioned (no `version` on the controller).
  app.enableVersioning({ type: VersioningType.URI });

  // Required so SIGTERM in K8s triggers OnModuleDestroy hooks.
  app.enableShutdownHooks();

  // Read port and cookie/CORS config via ConfigService so values come
  // from the validated env schema (parsed + coerced), not ad-hoc
  // process.env reads.
  const config = app.get(ConfigService<{ app: AppConfig }, true>);
  const port = config.get('app.port', { infer: true });
  const corsOrigins = config.get('app.cors.origins', { infer: true });
  const cookieSecure = config.get('app.cookie.secure', { infer: true });
  const cookieDomain = config.get('app.cookie.domain', { infer: true });
  const cookieSameSite = config.get('app.cookie.sameSite', { infer: true });

  // Register @fastify/cookie BEFORE listen so that cookie parsing is
  // available on every request. Plugin defaults apply to all setCookie
  // calls unless overridden per-call in the controller.
  //
  // Cast is required: two copies of the `fastify` types exist in the tree —
  // the root one @fastify/cookie is compiled against, and the one bundled
  // under @nestjs/platform-fastify that the adapter uses. They are
  // structurally identical at runtime, so we cast the plugin to the exact
  // parameter type `app.register` expects. Standard pattern for Fastify
  // plugins under the NestJS adapter.
  await app.register(fastifyCookie as unknown as Parameters<typeof app.register>[0], {
    defaults: {
      secure: cookieSecure,
      sameSite: cookieSameSite,
      // domain is optional — omit when undefined to avoid sending an explicit
      // Domain=undefined attribute which some browsers reject.
      ...(cookieDomain ? { domain: cookieDomain } : {}),
    },
  });

  // CORS — credentials:true requires an explicit origin allowlist.
  // Wildcard '*' with credentials is rejected by browsers and we
  // enforce it at config level (no wildcard in CORS_ORIGINS schema).
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Range', 'X-Request-Id'],
  });

  // Bind to 0.0.0.0 — without this, the container is unreachable from outside the pod.
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
