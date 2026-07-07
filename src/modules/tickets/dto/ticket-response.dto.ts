import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Output shape for a ticket. customerId is null when the subject name did
 * not match a known subscriber; assignee is a free-text agent name.
 * `category`/`photoUrl` are set for portal-reported tickets; the `csat*`
 * trio is set once the customer rates a resolved/breached ticket (P3.C.2) —
 * all nullable so existing consumers parsing an older payload still work.
 */
export const TicketResponseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  subject: z.string(),
  customerId: z.uuid().nullable(),
  customerName: z.string(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  status: z.enum(['open', 'in_progress', 'resolved', 'breached']),
  assignee: z.string().nullable(),
  slaDueAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  category: z.enum(['koneksi_putus', 'lambat', 'tagihan', 'perangkat', 'lainnya']).nullable(),
  photoUrl: z.string().nullable(),
  csatRating: z.number().int().min(1).max(5).nullable(),
  csatComment: z.string().nullable(),
  csatAt: z.iso.datetime().nullable(),
});

export type TicketResponse = z.infer<typeof TicketResponseSchema>;

export class TicketResponseDto extends createZodDto(TicketResponseSchema) {}

/**
 * Full-set status-count rollup for the ticket list. Computed over ALL
 * tickets — NEVER affected by status/q/paging (mirrors the
 * work-orders/invoices summary aggregate, FE contract parity). `breached`
 * is a raw status value (not a derived SLA condition) — see
 * `TicketsRepository.markBreachedPastSla` — so this is a straight grouped
 * count, same shape as `countByStatus()`. Every status key is always
 * present (zero-filled).
 */
export const TicketSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  byStatus: z.object({
    open: z.number().int().nonnegative(),
    in_progress: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
    breached: z.number().int().nonnegative(),
  }),
});

export type TicketSummary = z.infer<typeof TicketSummarySchema>;

/**
 * Paginated list response for GET /v1/tickets.
 *
 * - `items`   – current page (after status/q filter, sort, limit/offset).
 * - `total`   – count matching the current filter BEFORE paging.
 * - `summary` – full-set aggregate; NEVER affected by any filter or paging.
 */
export const TicketListResponseSchema = z.object({
  items: z.array(TicketResponseSchema),
  total: z.number().int().nonnegative(),
  summary: TicketSummarySchema,
});

export type TicketListResponse = z.infer<typeof TicketListResponseSchema>;

export class TicketListResponseDto extends createZodDto(TicketListResponseSchema) {}
