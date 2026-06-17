import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { InvoicesService } from './invoices.service';

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().min(1).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

// The recorded-payments ledger. Read-only here; payments are created as a
// side effect of settling an invoice.
@Controller({ path: 'payments', version: '1' })
export class PaymentsController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.invoices.listPayments(ListQuerySchema.parse(query));
  }
}
