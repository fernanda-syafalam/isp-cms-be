import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for a TR-069 managed device. */
export const AcsDeviceResponseSchema = z.object({
  id: z.uuid(),
  serial: z.string(),
  customerName: z.string(),
  model: z.string(),
  firmware: z.string(),
  rxPowerDbm: z.number().nullable(),
  status: z.enum(['online', 'offline']),
  lastInform: z.iso.datetime(),
});

export type AcsDeviceResponse = z.infer<typeof AcsDeviceResponseSchema>;
export class AcsDeviceResponseDto extends createZodDto(AcsDeviceResponseSchema) {}

/**
 * Full-set status-count rollup for the ACS device list. Computed over ALL
 * devices — NEVER affected by q or paging (mirrors the work-orders/invoices
 * summary aggregate, FE contract parity). Every status key is always
 * present (zero-filled).
 */
export const AcsSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  byStatus: z.object({
    online: z.number().int().nonnegative(),
    offline: z.number().int().nonnegative(),
  }),
});

export type AcsSummary = z.infer<typeof AcsSummarySchema>;

/**
 * Paginated list response for GET /v1/acs/devices.
 *
 * - `items`   – current page (after q filter, sort, limit/offset).
 * - `total`   – count matching the current q filter BEFORE paging.
 * - `summary` – full-set aggregate; NEVER affected by q or paging.
 */
export const AcsDeviceListResponseSchema = z.object({
  items: z.array(AcsDeviceResponseSchema),
  total: z.number().int().nonnegative(),
  summary: AcsSummarySchema,
});

export type AcsDeviceListResponse = z.infer<typeof AcsDeviceListResponseSchema>;

export class AcsDeviceListResponseDto extends createZodDto(AcsDeviceListResponseSchema) {}

/** Result of a bulk action — how many devices were affected. */
export const BulkAcsResultSchema = z.object({
  affected: z.number().int().nonnegative(),
});

export type BulkAcsResult = z.infer<typeof BulkAcsResultSchema>;
export class BulkAcsResultDto extends createZodDto(BulkAcsResultSchema) {}
