import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { InvoiceListResponseDto, InvoiceResponseDto } from './dto/invoice-response.dto';
import { RecordPaymentDto } from './dto/record-payment.dto';
import { InvoicesService } from './invoices.service';

const ListQuerySchema = z.object({
  status: z.enum(['draft', 'pending', 'partial', 'overdue', 'paid']).optional(),
  q: z.string().trim().min(1).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@Roles('admin', 'staff')
@Controller({ path: 'invoices', version: '1' })
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @ZodSerializerDto(InvoiceListResponseDto)
  list(@Query() query: unknown) {
    return this.invoices.list(ListQuerySchema.parse(query));
  }

  @Get(':id')
  @ZodSerializerDto(InvoiceResponseDto)
  findOne(@Param('id') id: string) {
    return this.invoices.findById(id);
  }

  // Record an offline / loket payment against the invoice.
  @Roles('admin', 'staff')
  @Audit('invoice.pay')
  @Post(':id/pay')
  @ZodSerializerDto(InvoiceResponseDto)
  pay(@Param('id') id: string, @Body() body: RecordPaymentDto) {
    return this.invoices.pay(id, body);
  }
}
