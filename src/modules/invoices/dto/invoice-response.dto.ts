import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Output shape for an invoice. Money fields are whole IDR; the total a
 * customer owes for this line is amount + lateFee + taxAmount. Period and
 * due dates are calendar dates ('YYYY-MM-DD'); paidAt / lastRemindedAt are
 * full ISO timestamps. `@ZodSerializerDto` strips anything not declared.
 */
export const InvoiceResponseSchema = z.object({
  id: z.uuid(),
  invoiceNo: z.string(),
  customerId: z.uuid(),
  customerName: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  amount: z.number().int().nonnegative(),
  lateFee: z.number().int().nonnegative(),
  taxAmount: z.number().int().nonnegative(),
  taxInvoiceNo: z.string().nullable(),
  status: z.enum(['draft', 'pending', 'overdue', 'paid']),
  dueDate: z.string(),
  paidAt: z.iso.datetime().nullable(),
  lastRemindedAt: z.iso.datetime().nullable(),
});

export type InvoiceResponse = z.infer<typeof InvoiceResponseSchema>;

export class InvoiceResponseDto extends createZodDto(InvoiceResponseSchema) {}

/**
 * Full-set summary aggregate for the invoices list.
 * Computed over ALL invoices — NEVER affected by status/q/paging.
 *
 * - outstanding: sum of grand total (amount + lateFee + taxAmount) for
 *   invoices with status 'pending' OR 'overdue'.
 * - overdue: sum of grand total for invoices with status 'overdue' only.
 * - unpaidCount: count of invoices with status 'pending' OR 'overdue'.
 * - total: count of ALL invoices (every status).
 */
export const InvoiceSummarySchema = z.object({
  outstanding: z.number().int().nonnegative(),
  overdue: z.number().int().nonnegative(),
  unpaidCount: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export type InvoiceSummary = z.infer<typeof InvoiceSummarySchema>;

/**
 * Paginated list response for GET /v1/invoices.
 *
 * - `items`   – current page (after status + q filter, sort, limit/offset).
 * - `total`   – count matching status+q filter BEFORE paging (drives page count).
 * - `summary` – full-set aggregate; NEVER affected by status/q/paging.
 */
export const InvoiceListResponseSchema = z.object({
  items: z.array(InvoiceResponseSchema),
  total: z.number().int().nonnegative(),
  summary: InvoiceSummarySchema,
});

export type InvoiceListResponse = z.infer<typeof InvoiceListResponseSchema>;

export class InvoiceListResponseDto extends createZodDto(InvoiceListResponseSchema) {}
