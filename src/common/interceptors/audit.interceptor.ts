import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { PinoLogger } from 'nestjs-pino';
import { type Observable, tap } from 'rxjs';
import { AUDIT_KEY } from '../decorators/audit.decorator';
import type { AuthUser } from '../decorators/current-user.decorator';

interface AuditEvent {
  audit: true;
  action: string;
  actor: string | null;
  target: unknown;
  outcome: 'success' | 'failure';
  err?: string;
}

/**
 * Emits a structured `audit: true` log line for any handler annotated
 * with `@Audit('<action>')`. Pino redact rules already strip secrets,
 * so the log shipper can split by `audit:true` and forward to the
 * compliance pipeline without further filtering.
 *
 * Wired globally via APP_INTERCEPTOR; handlers without `@Audit` are a
 * no-op pass-through.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('audit');
  }

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const action = this.reflector.getAllAndOverride<string | undefined>(AUDIT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!action) return next.handle();

    const req = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AuthUser; params: unknown }>();
    const actor = req.user?.id ?? null;
    const target = req.params;

    return next.handle().pipe(
      tap({
        next: () => {
          const event: AuditEvent = { audit: true, action, actor, target, outcome: 'success' };
          this.logger.info(event, 'audit event');
        },
        error: (err: unknown) => {
          const event: AuditEvent = {
            audit: true,
            action,
            actor,
            target,
            outcome: 'failure',
            err: err instanceof Error ? err.message : String(err),
          };
          this.logger.warn(event, 'audit event');
        },
      }),
    );
  }
}
