import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { WorkOrderResponseDto } from '../work-orders/dto/work-order-response.dto';
import { AddCommentDto } from './dto/add-comment.dto';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { TicketResponseDto } from './dto/ticket-response.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { TicketsService } from './tickets.service';

const ListQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  status: z.enum(['open', 'in_progress', 'resolved', 'breached']).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@Roles('admin', 'staff')
@Controller({ path: 'tickets', version: '1' })
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.tickets.list(ListQuerySchema.parse(query));
  }

  @Get(':id')
  @ZodSerializerDto(TicketResponseDto)
  findOne(@Param('id') id: string) {
    return this.tickets.findById(id);
  }

  @Get(':id/events')
  listEvents(@Param('id') id: string) {
    return this.tickets.listEvents(id);
  }

  @Roles('admin', 'staff')
  @Audit('ticket.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ZodSerializerDto(TicketResponseDto)
  create(@Body() body: CreateTicketDto, @CurrentUser() user: AuthUser) {
    return this.tickets.create(body, user.fullName);
  }

  @Roles('admin', 'staff')
  @Audit('ticket.update')
  @Patch(':id')
  @ZodSerializerDto(TicketResponseDto)
  update(@Param('id') id: string, @Body() body: UpdateTicketDto, @CurrentUser() user: AuthUser) {
    return this.tickets.update(id, body, user.fullName);
  }

  @Roles('admin', 'staff')
  @Audit('ticket.comment')
  @Post(':id/comments')
  @HttpCode(HttpStatus.CREATED)
  addComment(
    @Param('id') id: string,
    @Body() body: AddCommentDto,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.tickets.addComment(id, body, user.fullName);
  }

  // Dispatch a repair work order from this ticket.
  @Roles('admin', 'staff')
  @Audit('ticket.work_order')
  @Post(':id/work-order')
  @HttpCode(HttpStatus.CREATED)
  @ZodSerializerDto(WorkOrderResponseDto)
  createWorkOrder(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.tickets.createWorkOrder(id, user.fullName);
  }
}
