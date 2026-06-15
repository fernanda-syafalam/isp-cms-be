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
import { DevicesService } from './devices.service';
import { DeviceResponseDto } from './dto/device-response.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';

const ListQuerySchema = z.object({
  type: z.enum(['olt', 'onu', 'mikrotik']).optional(),
  status: z.enum(['online', 'degraded', 'offline']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

@Controller({ path: 'devices', version: '1' })
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.devices.list(ListQuerySchema.parse(query));
  }

  @Get(':id')
  @ZodSerializerDto(DeviceResponseDto)
  findOne(@Param('id') id: string) {
    return this.devices.findById(id);
  }

  @Roles('admin', 'staff')
  @Audit('device.reboot')
  @Post(':id/reboot')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(DeviceResponseDto)
  reboot(@Param('id') id: string) {
    return this.devices.reboot(id);
  }

  @Roles('admin', 'staff')
  @Audit('device.update')
  @Patch(':id')
  @ZodSerializerDto(DeviceResponseDto)
  update(@Param('id') id: string, @Body() body: UpdateDeviceDto) {
    return this.devices.update(id, body);
  }

  @Roles('admin', 'staff')
  @Audit('device.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.devices.remove(id);
  }
}
