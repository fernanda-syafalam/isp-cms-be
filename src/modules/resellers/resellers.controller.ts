import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AddLedgerEntryDto } from './dto/add-ledger-entry.dto';
import { ResellerResponseDto } from './dto/reseller-response.dto';
import { UpdateResellerDto } from './dto/update-reseller.dto';
import { ResellersService } from './resellers.service';

const ListQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const LedgerListQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@Controller({ path: 'resellers', version: '1' })
export class ResellersController {
  constructor(private readonly resellers: ResellersService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.resellers.list(ListQuerySchema.parse(query));
  }

  @Get(':id')
  @ZodSerializerDto(ResellerResponseDto)
  findOne(@Param('id') id: string) {
    return this.resellers.findById(id);
  }

  @Get(':id/ledger')
  listLedger(@Param('id') id: string, @Query() query: unknown) {
    return this.resellers.listLedger(id, LedgerListQuerySchema.parse(query));
  }

  @Roles('admin', 'staff')
  @Audit('reseller.update')
  @Patch(':id')
  @ZodSerializerDto(ResellerResponseDto)
  update(@Param('id') id: string, @Body() body: UpdateResellerDto) {
    return this.resellers.update(id, body);
  }

  // Add a balance ledger entry (topup/commission/deduction/withdrawal).
  // Returns the reseller with the updated balance; 422 if it would go
  // negative.
  @Roles('admin', 'staff')
  @Audit('reseller.ledger')
  @Post(':id/ledger')
  @ZodSerializerDto(ResellerResponseDto)
  addLedgerEntry(@Param('id') id: string, @Body() body: AddLedgerEntryDto) {
    return this.resellers.addLedgerEntry(id, body);
  }
}
