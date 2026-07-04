import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreatePoolDto, PoolResponseDto } from './dto/pool.dto';
import { PoolsService } from './pools.service';

@Roles('admin', 'staff')
@Controller({ path: 'routers/:routerId/pools', version: '1' })
export class PoolsController {
  constructor(private readonly pools: PoolsService) {}

  @Get()
  list(@Param('routerId') routerId: string) {
    return this.pools.list(routerId);
  }

  @Roles('admin', 'staff')
  @Audit('router.pool_create')
  @Post()
  @ZodSerializerDto(PoolResponseDto)
  create(@Param('routerId') routerId: string, @Body() body: CreatePoolDto) {
    return this.pools.create(routerId, body);
  }

  @Roles('admin', 'staff')
  @Audit('router.pool_delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('routerId') routerId: string, @Param('id') id: string): Promise<void> {
    return this.pools.remove(routerId, id);
  }
}
