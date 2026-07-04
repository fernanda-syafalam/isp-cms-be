import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { GenerateBatchDto } from './dto/generate-batch.dto';
import { RedeemVoucherSchema } from './dto/redeem-voucher.dto';
import { VoucherListResponseDto, VoucherResponseDto } from './dto/voucher-response.dto';
import { VouchersService } from './vouchers.service';

const ListQuerySchema = z.object({
  status: z.enum(['unused', 'used', 'expired']).optional(),
  q: z.string().trim().min(1).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@Roles('admin', 'staff')
@Controller({ path: 'vouchers', version: '1' })
export class VouchersController {
  constructor(private readonly vouchers: VouchersService) {}

  @Get()
  @ZodSerializerDto(VoucherListResponseDto)
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

  // Optional body: { customerName } sells the voucher to a subscriber and
  // credits their bill; no body is an anonymous hotspot redemption.
  @Roles('admin', 'staff')
  @Audit('voucher.redeem')
  @Post(':id/redeem')
  @ZodSerializerDto(VoucherResponseDto)
  redeem(@Param('id') id: string, @Body() body: unknown) {
    return this.vouchers.redeem(id, RedeemVoucherSchema.parse(body ?? {}));
  }
}
