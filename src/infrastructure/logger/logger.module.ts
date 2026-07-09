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
              // TOTP 2FA (login challenge + enroll/confirm/disable). `code`
              // is scoped to req.body only (not wildcarded) — it also names
              // unrelated business identifiers (ticket/work-order/voucher
              // codes) that must stay visible in logs.
              'req.body.code',
              'req.body.totpCode',
              '*.password',
              '*.passwordHash',
              '*.accessToken',
              '*.refreshToken',
              '*.twoFactorSecret',
              '*.otpauthUri',
              // F2: the AES-256-GCM key encrypting the TOTP secret at rest
              // (`TWOFA_ENC_KEY` / `AppConfig.twoFactor.encKey`). Nothing
              // logs this today (`TotpSecretCipherService` never logs it),
              // but redact it at the boundary too — cheap insurance
              // against a future accidental config dump.
              '*.encKey',
              '*.TWOFA_ENC_KEY',
              // ADR-0016: Tripay gateway credentials
              // (`AppConfig.payment.tripay.*`). Nothing logs these today
              // either (`TripayPaymentGateway` never logs a config dump),
              // same cheap-insurance rationale as `encKey` above.
              '*.privateKey',
              '*.apiKey',
              '*.merchantCode',
              // UU PDP (Indonesian data-protection law): customer personal
              // data must not land in the prod log shipper in clear text.
              // These were leaking on the notification happy path
              // (`{ to: input.to }` = customer phone/email, logged at info on
              // every send) and on a few work-order/ACS lines
              // (`{ customerName }`) — redact them at the boundary so no
              // current OR future call site can leak them (R8-OBS-1/4). The
              // `req` serializer already strips request bodies, but these
              // wildcards make the wildcard tier self-sufficient if that
              // serializer is ever relaxed for debugging (R8-OBS-6). `*.to`
              // may over-redact a date-range filter's `to` field — harmless
              // over-redaction, worth it to guarantee no recipient leaks.
              '*.to',
              '*.recipient',
              '*.phone',
              '*.customerPhone',
              '*.email',
              '*.customerEmail',
              '*.customerName',
              '*.ktp',
              '*.npwp',
              '*.address',
              '*.lat',
              '*.lng',
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
