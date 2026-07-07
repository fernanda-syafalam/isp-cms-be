import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AcsService } from './acs.service';
import { AcsDeviceListResponseDto } from './dto/acs-response.dto';
import { BulkAcsDto } from './dto/bulk-acs.dto';

const ListQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

@Roles('admin', 'staff', 'teknisi')
@Controller({ path: 'acs', version: '1' })
export class AcsController {
  constructor(private readonly acs: AcsService) {}

  @Get('devices')
  @ZodSerializerDto(AcsDeviceListResponseDto)
  listDevices(@Query() query: unknown) {
    return this.acs.list(ListQuerySchema.parse(query));
  }

  // One endpoint for reboot / firmware / wifi across many devices.
  @Roles('admin', 'staff', 'teknisi')
  @Audit('acs.bulk')
  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  bulk(@Body() body: BulkAcsDto) {
    return this.acs.bulk(body);
  }
}
