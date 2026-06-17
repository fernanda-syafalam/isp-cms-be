import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Mirror of the FE OdpRecordSchema (src/schemas/odp.ts).
export const OdpRecordResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  area: z.string(),
  splitter: z.string(),
  totalPorts: z.number().int().positive(),
  usedPorts: z.number().int().nonnegative(),
  avgRxPowerDbm: z.number(),
  status: z.enum(['healthy', 'warning', 'critical']),
});

/**
 * Fleet-level aggregate computed over the FULL ODP set (never filtered).
 * Invariant: searching, filtering, or paging must not change it.
 */
export const OdpSummarySchema = z.object({
  /** Count of all ODP records regardless of filter. */
  totalOdp: z.number().int().nonnegative(),
  /** Fleet utilization: round(Σ(usedPorts) / Σ(totalPorts) * 100), 0 if no ports. */
  utilization: z.number().int().nonnegative(),
  /** Count of ODP with totalPorts - usedPorts === 0 (no free port). */
  full: z.number().int().nonnegative(),
  /** Count of ODP with status !== 'healthy'. */
  optical: z.number().int().nonnegative(),
});

export const OdpListResponseSchema = z.object({
  items: z.array(OdpRecordResponseSchema),
  /** Count after view + q filters, before paging — drives page count. */
  total: z.number().int().nonnegative(),
  summary: OdpSummarySchema,
});

export type OdpRecordResponse = z.infer<typeof OdpRecordResponseSchema>;
export type OdpSummary = z.infer<typeof OdpSummarySchema>;
export type OdpListResponse = z.infer<typeof OdpListResponseSchema>;

export class OdpListResponseDto extends createZodDto(OdpListResponseSchema) {}
