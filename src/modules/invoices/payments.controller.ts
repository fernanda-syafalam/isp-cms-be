import { Controller, Get, Query } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { z } from 'zod';
import { Roles } from '../../common/decorators/roles.decorator';
import { PaymentReconciliationDto } from './dto/payment-reconciliation.dto';
import { InvoicesService } from './invoices.service';

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().min(1).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

const ReconciliationQuerySchema = z.object({
  // Defaults to today (server clock, UTC) when omitted.
  date: z.iso.date().optional(),
});

// The recorded-payments ledger. Read-only here; payments are created as a
// side effect of settling an invoice.
@Roles('admin', 'staff')
@Controller({ path: 'payments', version: '1' })
export class PaymentsController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.invoices.listPayments(ListQuerySchema.parse(query));
  }

  // The loket/cash-drawer closing report for one day (P3.A.4).
  @Roles('admin', 'staff')
  @Get('reconciliation')
  @ZodSerializerDto(PaymentReconciliationDto)
  reconciliation(@Query() query: unknown) {
    const { date } = ReconciliationQuerySchema.parse(query);
    return this.invoices.reconciliation(date ?? todayUtc());
  }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
