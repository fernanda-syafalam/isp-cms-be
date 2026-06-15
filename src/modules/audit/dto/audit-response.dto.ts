import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** One audit-trail entry — mirrors the FE `AuditEntrySchema`. */
export const AuditEntryResponseSchema = z.object({
  id: z.string(),
  at: z.iso.datetime(),
  actor: z.string(),
  action: z.string(),
  entity: z.string(),
  summary: z.string(),
  // Omitted (not null) when the action does not target a single record.
  entityId: z.string().optional(),
});
export type AuditEntryResponse = z.infer<typeof AuditEntryResponseSchema>;

/** Paginated audit list — mirrors the FE `AuditListSchema`. */
export const AuditListResponseSchema = z.object({
  items: z.array(AuditEntryResponseSchema),
  total: z.number().int().nonnegative(),
});
export type AuditListResponse = z.infer<typeof AuditListResponseSchema>;
export class AuditListResponseDto extends createZodDto(AuditListResponseSchema) {}
