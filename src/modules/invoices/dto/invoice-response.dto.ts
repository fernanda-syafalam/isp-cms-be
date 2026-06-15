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
