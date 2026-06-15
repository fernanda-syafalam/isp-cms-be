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
} from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateQueueDto, QueueResponseDto, UpdateQueueDto } from './dto/queue.dto';
import { QueuesService } from './queues.service';

@Controller({ path: 'routers/:routerId/queues', version: '1' })
export class QueuesController {
  constructor(private readonly queues: QueuesService) {}

  @Get()
  list(@Param('routerId') routerId: string) {
    return this.queues.list(routerId);
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
