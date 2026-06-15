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
import { BranchesService } from './branches.service';
import { BranchResponseDto, CreateBranchDto, UpdateBranchDto } from './dto/branch.dto';

const ListQuerySchema = z.object({
  status: z.enum(['active', 'inactive']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@Controller({ path: 'branches', version: '1' })
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.branches.list(ListQuerySchema.parse(query));
  }

  @Roles('admin', 'staff')
  @Audit('branch.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ZodSerializerDto(BranchResponseDto)
  create(@Body() body: CreateBranchDto) {
    return this.branches.create(body);
  }

  // Edit / deactivate (status: 'inactive').
  @Roles('admin', 'staff')
  @Audit('branch.update')
  @Patch(':id')
  @ZodSerializerDto(BranchResponseDto)
  update(@Param('id') id: string, @Body() body: UpdateBranchDto) {
    return this.branches.update(id, body);
  }
}
