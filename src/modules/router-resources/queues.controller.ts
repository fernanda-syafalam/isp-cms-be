import {
  Body,
  Controller,
  Delete,
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
import { Roles } from '../../common/decorators/roles.decorator';
import {
  CreateQueueDto,
  QueueListResponseDto,
  QueueResponseDto,
  UpdateQueueDto,
} from './dto/queue.dto';
import { QueuesService } from './queues.service';

const ListQuerySchema = z.object({
  q: z.string().optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

@Roles('admin', 'staff')
@Controller({ path: 'routers/:routerId/queues', version: '1' })
export class QueuesController {
  constructor(private readonly queues: QueuesService) {}

  @Get()
  @ZodSerializerDto(QueueListResponseDto)
  list(@Param('routerId') routerId: string, @Query() query: unknown) {
    return this.queues.list(routerId, ListQuerySchema.parse(query));
  }

  @Roles('admin', 'staff')
  @Audit('router.queue_create')
  @Post()
  @ZodSerializerDto(QueueResponseDto)
  create(@Param('routerId') routerId: string, @Body() body: CreateQueueDto) {
    return this.queues.create(routerId, body);
  }

  @Roles('admin', 'staff')
  @Audit('router.queue_update')
  @Patch(':id')
  @ZodSerializerDto(QueueResponseDto)
  update(
    @Param('routerId') routerId: string,
    @Param('id') id: string,
    @Body() body: UpdateQueueDto,
  ) {
    return this.queues.update(routerId, id, body);
  }

  @Roles('admin', 'staff')
  @Audit('router.queue_delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('routerId') routerId: string, @Param('id') id: string): Promise<void> {
    return this.queues.remove(routerId, id);
  }
}
