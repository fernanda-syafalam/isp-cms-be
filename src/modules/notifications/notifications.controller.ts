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
import { Roles } from '../../common/decorators/roles.decorator';
import { NotificationTemplateResponseDto } from './dto/notification-response.dto';
import { SendNotificationDto } from './dto/send-notification.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { NotificationsService } from './notifications.service';

const LogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('templates')
  listTemplates() {
    return this.notifications.listTemplates();
  }

  @Roles('admin', 'staff')
  @Audit('notification.template_update')
  @Patch('templates/:id')
  @ZodSerializerDto(NotificationTemplateResponseDto)
  updateTemplate(@Param('id') id: string, @Body() body: UpdateTemplateDto) {
    return this.notifications.updateTemplate(id, body);
  }

  @Get('log')
  listLog(@Query() query: unknown) {
    return this.notifications.listLog(LogQuerySchema.parse(query));
  }

  // Render the event template and append a send-log entry.
  @Roles('admin', 'staff')
  @Audit('notification.send')
  @Post('send')
  @HttpCode(HttpStatus.CREATED)
  send(@Body() body: SendNotificationDto): Promise<void> {
    return this.notifications.send(body);
  }
}
