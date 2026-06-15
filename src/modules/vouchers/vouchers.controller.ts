import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { GenerateBatchDto } from './dto/generate-batch.dto';
import { VoucherResponseDto } from './dto/voucher-response.dto';
import { VouchersService } from './vouchers.service';

const ListQuerySchema = z.object({
  status: z.enum(['unused', 'used', 'expired']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

@Controller({ path: 'vouchers', version: '1' })
export class VouchersController {
  constructor(private readonly vouchers: VouchersService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.vouchers.list(ListQuerySchema.parse(query));
  }

  // Mint a batch — returns { batchId, created }, not a single voucher.
  @Roles('admin', 'staff')
  @Audit('voucher.batch')
  @Post('batch')
  @HttpCode(HttpStatus.CREATED)
  generateBatch(@Body() body: GenerateBatchDto) {
    return this.vouchers.generateBatch(body);
  }

  @Roles('admin', 'staff')
  @Audit('voucher.redeem')
  @Post(':id/redeem')
  @ZodSerializerDto(VoucherResponseDto)
  redeem(@Param('id') id: string) {
    return this.vouchers.redeem(id);
  }
}
