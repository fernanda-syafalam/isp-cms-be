import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateSlaCreditDto } from './dto/create-sla-credit.dto';
import { SlaCreditResponseDto } from './dto/sla-credit-response.dto';
import { SlaCreditsService } from './sla-credits.service';

const ListQuerySchema = z.object({
  status: z.enum(['pending', 'applied', 'void']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@Controller({ path: 'sla-credits', version: '1' })
export class SlaCreditsController {
  constructor(private readonly slaCredits: SlaCreditsService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.slaCredits.list(ListQuerySchema.parse(query));
  }

  @Roles('admin', 'staff')
  @Audit('sla_credit.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ZodSerializerDto(SlaCreditResponseDto)
  create(@Body() body: CreateSlaCreditDto) {
    return this.slaCredits.create(body);
  }

  @Roles('admin', 'staff')
  @Audit('sla_credit.apply')
  @Post(':id/apply')
  @ZodSerializerDto(SlaCreditResponseDto)
  apply(@Param('id') id: string) {
    return this.slaCredits.apply(id);
  }

  @Roles('admin', 'staff')
  @Audit('sla_credit.void')
  @Post(':id/void')
  @ZodSerializerDto(SlaCreditResponseDto)
  void(@Param('id') id: string) {
    return this.slaCredits.void(id);
  }
}
