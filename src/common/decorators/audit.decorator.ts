import { SetMetadata } from '@nestjs/common';

export const AUDIT_KEY = 'audit';

/**
 * Marks a handler as an "audited operation". `AuditInterceptor` reads
 * this metadata and emits a structured log line tagged `audit: true`
 * with actor, action, target, and outcome. Use for state-changing
 * operations on sensitive resources (auth events, role changes,
 * financial actions). See Pilar 4.
 */
export const Audit = (action: string) => SetMetadata(AUDIT_KEY, action);
