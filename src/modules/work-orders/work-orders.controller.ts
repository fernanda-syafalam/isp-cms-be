import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { WorkOrderResponseDto } from './dto/work-order-response.dto';
import { WorkOrdersService } from './work-orders.service';

const ListQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  status: z.enum(['scheduled', 'in_progress', 'done', 'cancelled']).optional(),
  type: z.enum(['install', 'repair', 'dismantle']).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@Roles('admin', 'staff', 'teknisi')
@Controller({ path: 'work-orders', version: '1' })
export class WorkOrdersController {
  constructor(private readonly workOrders: WorkOrdersService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.workOrders.list(ListQuerySchema.parse(query));
  }

  // Complete an order. For installs this runs the activation cascade
  // (customer + connection + first invoice). Idempotent.
  @Roles('admin', 'staff', 'teknisi')
  @Audit('work_order.complete')
  @Post(':id/complete')
  @ZodSerializerDto(WorkOrderResponseDto)
  complete(@Param('id') id: string) {
    return this.workOrders.complete(id);
  }
}
