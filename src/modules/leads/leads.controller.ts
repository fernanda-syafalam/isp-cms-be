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
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadResponseDto } from './dto/lead-response.dto';
import { UpdateLeadStageDto } from './dto/update-lead-stage.dto';
import { LeadsService } from './leads.service';

const ListQuerySchema = z.object({
  stage: z.enum(['new', 'survey', 'quote', 'won', 'lost']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@Controller({ path: 'leads', version: '1' })
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.leads.list(ListQuerySchema.parse(query));
  }

  @Roles('admin', 'staff')
  @Audit('lead.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ZodSerializerDto(LeadResponseDto)
  create(@Body() body: CreateLeadDto) {
    return this.leads.create(body);
  }

  @Roles('admin', 'staff')
  @Audit('lead.stage')
  @Patch(':id/stage')
  @ZodSerializerDto(LeadResponseDto)
  updateStage(@Param('id') id: string, @Body() body: UpdateLeadStageDto) {
    return this.leads.updateStage(id, body);
  }

  // Convert to a subscriber + scheduled install. Idempotent.
  @Roles('admin', 'staff')
  @Audit('lead.convert')
  @Post(':id/convert')
  @ZodSerializerDto(LeadResponseDto)
  convert(@Param('id') id: string) {
    return this.leads.convert(id);
  }
}
