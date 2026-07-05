import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AssignWorkOrderDto } from './dto/assign-work-order.dto';
import { RescheduleWorkOrderDto } from './dto/reschedule-work-order.dto';
import { WorkOrderResponseDto } from './dto/work-order-response.dto';
import { WorkOrdersService } from './work-orders.service';

const ListQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  status: z.enum(['scheduled', 'in_progress', 'done', 'cancelled']).optional(),
  type: z.enum(['install', 'repair', 'dismantle']).optional(),
  // "Tugas saya" (P3.B.1): exact technician name.
  technician: z.string().trim().min(1).optional(),
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
  complete(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.workOrders.complete(id, user.fullName);
  }

  // --- State machine (P3.B.2) — in_progress/cancelled were unreachable ---

  // Start a scheduled order (→ in_progress).
  @Roles('admin', 'staff', 'teknisi')
  @Audit('work_order.start')
  @Post(':id/start')
  @ZodSerializerDto(WorkOrderResponseDto)
  start(@Param('id') id: string) {
    return this.workOrders.start(id);
  }

  // Cancel an open order (→ cancelled).
  @Roles('admin', 'staff', 'teknisi')
  @Audit('work_order.cancel')
  @Post(':id/cancel')
  @ZodSerializerDto(WorkOrderResponseDto)
  cancel(@Param('id') id: string) {
    return this.workOrders.cancel(id);
  }

  // (Re)assign the field technician.
  @Roles('admin', 'staff', 'teknisi')
  @Audit('work_order.assign')
  @Post(':id/assign')
  @ZodSerializerDto(WorkOrderResponseDto)
  assign(@Param('id') id: string, @Body() body: AssignWorkOrderDto) {
    return this.workOrders.assign(id, body.technician);
  }

  // Reschedule an open order to a new date/time.
  @Roles('admin', 'staff', 'teknisi')
  @Audit('work_order.reschedule')
  @Post(':id/reschedule')
  @ZodSerializerDto(WorkOrderResponseDto)
  reschedule(@Param('id') id: string, @Body() body: RescheduleWorkOrderDto) {
    return this.workOrders.reschedule(id, new Date(body.scheduledAt));
  }
}
