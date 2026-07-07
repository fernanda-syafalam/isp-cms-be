import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Output shape for a work order. customerId is null for a dispatch with
 * no matching subscriber; technician is a free-text name.
 */
export const WorkOrderResponseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  type: z.enum(['install', 'repair', 'dismantle']),
  customerId: z.uuid().nullable(),
  customerName: z.string(),
  technician: z.string().nullable(),
  scheduledAt: z.iso.datetime(),
  status: z.enum(['scheduled', 'in_progress', 'done', 'cancelled']),
  // Set only for a repair WO dispatched from a ticket (P3.B.4). Completing
  // such a WO auto-resolves the linked ticket.
  ticketId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  // Field-completion evidence captured on complete() (P3.B.3). All null
  // until the order is completed with a field kit.
  scannedOnuSerial: z.string().nullable(),
  measuredRxPower: z.number().nullable(),
  photos: z.array(z.string()).nullable(),
  signatureUrl: z.string().nullable(),
  gpsLat: z.number().nullable(),
  gpsLng: z.number().nullable(),
  // Free-text field notes the technician enters on completion ("Catatan").
  completionNotes: z.string().nullable(),
  completedAt: z.iso.datetime().nullable(),
  completedBy: z.string().nullable(),
});

export type WorkOrderResponse = z.infer<typeof WorkOrderResponseSchema>;

export class WorkOrderResponseDto extends createZodDto(WorkOrderResponseSchema) {}

/**
 * Full-set status-count rollup for the work-orders list. Computed over ALL
 * work orders — NEVER affected by status/type/q/technician/paging (mirrors
 * the invoices summary aggregate, ADR-0009 style). Drives the FE KPI cards
 * and status filter tabs, which must stay stable while the page filter
 * changes. Every status key is always present (zero-filled).
 */
export const WorkOrderSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  byStatus: z.object({
    scheduled: z.number().int().nonnegative(),
    in_progress: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
});

export type WorkOrderSummary = z.infer<typeof WorkOrderSummarySchema>;

/**
 * Paginated list response for GET /v1/work-orders.
 *
 * - `items`   – current page (after q/status/type/technician filter, sort, limit/offset).
 * - `total`   – count matching the current filter BEFORE paging (drives page count).
 * - `summary` – full-set aggregate; NEVER affected by any filter or paging.
 */
export const WorkOrderListResponseSchema = z.object({
  items: z.array(WorkOrderResponseSchema),
  total: z.number().int().nonnegative(),
  summary: WorkOrderSummarySchema,
});

export type WorkOrderListResponse = z.infer<typeof WorkOrderListResponseSchema>;

export class WorkOrderListResponseDto extends createZodDto(WorkOrderListResponseSchema) {}
