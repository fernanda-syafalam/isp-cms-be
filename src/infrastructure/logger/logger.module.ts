import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import type { AppConfig } from '../../config/configuration';

/**
 * Pino logger wired up per Pilar 6:
 *
 * - JSON output by default; pino-pretty only for local development so
 *   the production log shipper does not have to parse pretty text.
 * - Each log line carries the Fastify request id (from `genReqId` in
 *   main.ts) so a single request can be traced through every line it
 *   produced.
 * - Sensitive fields are redacted at the logger boundary instead of at
 *   each call site — defence in depth against accidental leaks of
 *   passwords, tokens, and authorization headers.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<{ app: AppConfig }, true>) => ({
        pinoHttp: {
          level: config.get('app.logLevel', { infer: true }),
          autoLogging: true,
          customProps: (req) => ({ requestId: req.id }),
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.body.password',
              '*.initialPassword',
              'req.body.passwordHash',
              'req.body.token',
              'req.body.accessToken',
              'req.body.refreshToken',
              '*.password',
              '*.passwordHash',
              '*.accessToken',
              '*.refreshToken',
            ],
            censor: '[REDACTED]',
          },
          serializers: {
            req: (req) => ({ method: req.method, url: req.url, id: req.id }),
            res: (res) => ({ statusCode: res.statusCode }),
          },
          transport:
            config.get('app.nodeEnv', { infer: true }) === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
    }),
  ],
})
export class AppLoggerModule {}
