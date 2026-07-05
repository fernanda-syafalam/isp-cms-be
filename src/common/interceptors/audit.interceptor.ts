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
import type { NewAuditLogEntry } from '../../infrastructure/database/schema/audit.schema';
import { AuditRepository } from '../../modules/audit/audit.repository';
import { AUDIT_KEY, type AuditMeta } from '../decorators/audit.decorator';
import type { AuthUser } from '../decorators/current-user.decorator';

interface AuditEvent {
  audit: true;
  action: string;
  actor: string | null;
  target: unknown;
  outcome: 'success' | 'failure';
  err?: string;
}

// entity_id column is varchar(120); actor/entity/summary are NOT NULL.
const ENTITY_ID_MAX = 120;

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
    private readonly auditRepo: AuditRepository,
  ) {
    this.logger.setContext('audit');
  }

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<AuditMeta | undefined>(AUDIT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!meta) return next.handle();
    const { action } = meta;

    const req = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AuthUser; params?: { id?: unknown } }>();
    const actor = req.user?.id ?? null;
    const target = req.params;
    // NOT NULL actor column — public endpoints (e.g. auth.login) have no user.
    const actorLabel = req.user?.email ?? req.user?.id ?? 'system';
    // Prefer the decorator-provided entity, else the action prefix.
    const entity = meta.entity ?? action.split('.')[0] ?? action;
    const entityId =
      typeof req.params?.id === 'string' ? req.params.id.slice(0, ENTITY_ID_MAX) : undefined;

    return next.handle().pipe(
      tap({
        next: () => {
          const event: AuditEvent = { audit: true, action, actor, target, outcome: 'success' };
          this.logger.info(event, 'audit event');
          // Persist the queryable trail. Fire-and-forget: a DB error must never
          // fail the audited request or block its response.
          const entry: NewAuditLogEntry = {
            actor: actorLabel,
            action,
            entity,
            summary: entityId ? `${action} #${entityId}` : action,
            entityId,
          };
          void this.auditRepo
            .record(entry)
            .catch((e: unknown) =>
              this.logger.warn({ audit: true, err: String(e) }, 'audit persist failed'),
            );
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
