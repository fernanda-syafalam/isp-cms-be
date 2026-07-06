import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AnnouncementsService } from './announcements.service';
import { AnnouncementResponseDto } from './dto/announcement-response.dto';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';

/**
 * Announcements & outage notices. GET (active feed) is open to any
 * authenticated role — customers also read the identical feed via
 * `/v1/portal/announcements`; this endpoint stays for staff-side previews
 * and any non-portal consumer. Admin management is staff-only.
 */
@Controller({ path: 'announcements', version: '1' })
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  listActive() {
    return this.announcements.listActive();
  }

  @Roles('admin', 'staff')
  @Get('admin')
  listAll() {
    return this.announcements.list();
  }

  @Roles('admin', 'staff')
  @Audit('announcement.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ZodSerializerDto(AnnouncementResponseDto)
  create(@Body() body: CreateAnnouncementDto) {
    return this.announcements.create(body);
  }

  @Roles('admin', 'staff')
  @Audit('announcement.deactivate')
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(AnnouncementResponseDto)
  deactivate(@Param('id') id: string) {
    return this.announcements.deactivate(id);
  }
}
