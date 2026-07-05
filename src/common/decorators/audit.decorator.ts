import { SetMetadata } from '@nestjs/common';

export const AUDIT_KEY = 'audit';

export interface AuditMeta {
  action: string;
  // Optional entity label. When omitted the interceptor derives it from the
  // action prefix before the first '.' (e.g. 'customer.suspend' -> 'customer').
  entity?: string;
}

/**
 * Marks a handler as an "audited operation". `AuditInterceptor` reads this
 * metadata and, on success, both emits a structured `audit: true` pino line
 * AND persists a row to the `audit_log` table (the queryable trail backing the
 * FE audit page). Use for state-changing operations on sensitive resources
 * (auth events, role changes, financial actions). See Pilar 4.
 *
 * `entity` is optional and backward-compatible: existing `@Audit('x.y')` call
 * sites keep working and fall back to the derived label.
 */
export const Audit = (action: string, entity?: string) =>
  SetMetadata<string, AuditMeta>(AUDIT_KEY, { action, entity });
