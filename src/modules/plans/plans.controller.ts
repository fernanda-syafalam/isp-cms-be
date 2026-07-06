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
import { AnyAuthenticatedRole } from '../../common/decorators/any-authenticated-role.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreatePlanDto } from './dto/create-plan.dto';
import { PlanResponseDto } from './dto/plan-response.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { PlansService } from './plans.service';

const ListQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@Controller({ path: 'plans', version: '1' })
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  // Plan catalog contains no sensitive fields (name/speed/price/status) —
  // any authenticated role, including customer, may browse it (e.g. a
  // self-service upgrade flow). Flagged by the route-guardrail test as
  // previously undocumented; recorded explicitly here.
  @AnyAuthenticatedRole()
  @Get()
  list(@Query() query: unknown) {
    return this.plans.list(ListQuerySchema.parse(query));
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
