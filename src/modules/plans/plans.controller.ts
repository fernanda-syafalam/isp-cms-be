import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreatePlanDto } from './dto/create-plan.dto';
import { PlanResponseDto } from './dto/plan-response.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { PlansService } from './plans.service';

@Controller({ path: 'plans', version: '1' })
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  // Any authenticated user may read the catalogue. Plans are few, so the
  // list is unpaginated — { items, total }.
  @Get()
  async list() {
    const items = await this.plans.list();
    return { items, total: items.length };
  }

  @Roles('admin')
  @Audit('plan.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ZodSerializerDto(PlanResponseDto)
  create(@Body() body: CreatePlanDto) {
    return this.plans.create(body);
  }

  @Roles('admin')
  @Audit('plan.update')
  @Patch(':id')
  @ZodSerializerDto(PlanResponseDto)
  update(@Param('id') id: string, @Body() body: UpdatePlanDto) {
    return this.plans.update(id, body);
  }

  // Archive (soft-retire) — status transition, not a delete, so historical
  // references keep resolving.
  @Roles('admin')
  @Audit('plan.archive')
  @Post(':id/archive')
  @ZodSerializerDto(PlanResponseDto)
  archive(@Param('id') id: string) {
    return this.plans.archive(id);
  }
}
