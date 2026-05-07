import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

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

  const port = Number(process.env.PORT ?? 3000);
  // Bind to 0.0.0.0 — without this, the container is unreachable from outside the pod.
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
