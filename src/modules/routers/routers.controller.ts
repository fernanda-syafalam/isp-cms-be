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
import { ConnectRouterDto } from './dto/connect-router.dto';
import {
  RouterListResponseDto,
  RouterResponseDto,
  TestConnectionResultDto,
} from './dto/router-response.dto';
import { UpdateRouterDto } from './dto/update-router.dto';
import { RoutersService } from './routers.service';

const ListQuerySchema = z.object({
  status: z.enum(['online', 'offline']).optional(),
  q: z.string().trim().min(1).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@Roles('admin', 'staff', 'teknisi')
@Controller({ path: 'routers', version: '1' })
export class RoutersController {
  constructor(private readonly routers: RoutersService) {}

  @Get()
  @ZodSerializerDto(RouterListResponseDto)
  list(@Query() query: unknown) {
    return this.routers.list(ListQuerySchema.parse(query));
  }

  // Probe a device without saving — declared before the param routes.
  @Roles('admin', 'staff')
  @Audit('router.test_connection')
  @Post('test-connection')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(TestConnectionResultDto)
  testConnection(@Body() body: ConnectRouterDto) {
    return this.routers.testConnection(body);
  }

  @Roles('admin', 'staff')
  @Audit('router.connect')
  @Post()
  @ZodSerializerDto(RouterResponseDto)
  connect(@Body() body: ConnectRouterDto) {
    return this.routers.connect(body);
  }

  @Get(':id')
  @ZodSerializerDto(RouterResponseDto)
  findOne(@Param('id') id: string) {
    return this.routers.findById(id);
  }

  // SEC-M1: also the write path for the per-router API credential
  // (apiUsername/password) and, notably, `host` — a host-change is audited
  // both generically here (@Audit) and with a dedicated warning log in the
  // service when it actually changes.
  @Roles('admin', 'staff')
  @Audit('router.update')
  @Patch(':id')
  @ZodSerializerDto(RouterResponseDto)
  update(@Param('id') id: string, @Body() body: UpdateRouterDto, @CurrentUser() user: AuthUser) {
    return this.routers.update(id, body, user.email ?? user.id);
  }

  @Roles('admin', 'staff')
  @Audit('router.sync')
  @Post(':id/sync')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(RouterResponseDto)
  sync(@Param('id') id: string) {
    return this.routers.sync(id);
  }

  @Roles('admin', 'staff')
  @Audit('router.reboot')
  @Post(':id/reboot')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(RouterResponseDto)
  reboot(@Param('id') id: string) {
    return this.routers.reboot(id);
  }

  @Roles('admin', 'staff')
  @Audit('router.test')
  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(RouterResponseDto)
  test(@Param('id') id: string) {
    return this.routers.test(id);
  }
}
