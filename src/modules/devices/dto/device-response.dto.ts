import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** A single managed device — mirrors the FE `DeviceSchema`. */
export const DeviceResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.enum(['olt', 'onu', 'mikrotik']),
  ipAddress: z.string(),
  status: z.enum(['online', 'degraded', 'offline']),
  uptimeHours: z.number().nonnegative(),
  rxPower: z.number().nullable(),
  areaName: z.string(),
  lastSeenAt: z.iso.datetime(),
  topologyNodeId: z.string().nullable(),
});
export type DeviceResponse = z.infer<typeof DeviceResponseSchema>;
export class DeviceResponseDto extends createZodDto(DeviceResponseSchema) {}

/**
 * Full-set status-count rollup for the device fleet list. Computed over ALL
 * devices — NEVER affected by type/status/q/paging (mirrors the
 * work-orders/invoices summary aggregate, FE contract parity). Every status
 * key is always present (zero-filled).
 */
export const DeviceSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  byStatus: z.object({
    online: z.number().int().nonnegative(),
    degraded: z.number().int().nonnegative(),
    offline: z.number().int().nonnegative(),
  }),
});
export type DeviceSummary = z.infer<typeof DeviceSummarySchema>;

/**
 * Paginated list response for GET /v1/devices.
 *
 * - `items`   – current page (after type/status/q filter, sort, limit/offset).
 * - `total`   – count matching the current filter BEFORE paging.
 * - `summary` – full-set aggregate; NEVER affected by any filter or paging.
 */
export const DeviceListResponseSchema = z.object({
  items: z.array(DeviceResponseSchema),
  total: z.number().int().nonnegative(),
  summary: DeviceSummarySchema,
});
export type DeviceListResponse = z.infer<typeof DeviceListResponseSchema>;
export class DeviceListResponseDto extends createZodDto(DeviceListResponseSchema) {}
