import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Disable Fastify's built-in logger; nestjs-pino will be wired in later.
      logger: false,
      // Required when running behind an ingress / load balancer in K8s.
      trustProxy: true,
      // Default 1 MB body limit; raise explicitly per route if needed.
      bodyLimit: 1_048_576,
      genReqId: (req: IncomingMessage) => req.headers['x-request-id']?.toString() ?? randomUUID(),
    }),
  );

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
