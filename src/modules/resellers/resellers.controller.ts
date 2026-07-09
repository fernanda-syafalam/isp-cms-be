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
import { AddLedgerEntryDto } from './dto/add-ledger-entry.dto';
import { CreatePayoutDto } from './dto/create-payout.dto';
import { CreateResellerDto } from './dto/create-reseller.dto';
import { PayoutResponseDto } from './dto/payout-response.dto';
import { ResellerListResponseDto, ResellerResponseDto } from './dto/reseller-response.dto';
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

const PayoutListQuerySchema = z.object({
  status: z.enum(['requested', 'approved', 'rejected', 'paid']).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@Roles('admin', 'staff')
@Controller({ path: 'resellers', version: '1' })
export class ResellersController {
  constructor(private readonly resellers: ResellersService) {}

  @Get()
  @ZodSerializerDto(ResellerListResponseDto)
  list(@Query() query: unknown) {
    return this.resellers.list(ListQuerySchema.parse(query));
  }

  @Audit('reseller.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ZodSerializerDto(ResellerResponseDto)
  create(@Body() body: CreateResellerDto) {
    return this.resellers.create(body);
  }

  // A mitra reads their own reseller only (ownership enforced in the
  // service — misses 404); staff read anyone.
  @Roles('admin', 'staff', 'mitra')
  @Get(':id')
  @ZodSerializerDto(ResellerResponseDto)
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.resellers.findById(id, user);
  }

  @Roles('admin', 'staff', 'mitra')
  @Get(':id/ledger')
  listLedger(@Param('id') id: string, @Query() query: unknown, @CurrentUser() user: AuthUser) {
    return this.resellers.listLedger(id, LedgerListQuerySchema.parse(query), user);
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

  // --- Payout lifecycle (P3.D.4) ---------------------------------------
  // requested -> approved -> paid (disbursed, debits the balance), or
  // requested -> rejected. A mitra may self-request a payout for their own
  // reseller (ownership + balance enforced in the service, ADR-0010); only
  // admin/staff may approve/reject/disburse.

  @Roles('admin', 'staff', 'mitra')
  @Get(':id/payouts')
  listPayouts(@Param('id') id: string, @Query() query: unknown, @CurrentUser() user: AuthUser) {
    return this.resellers.listPayouts(id, PayoutListQuerySchema.parse(query), user);
  }

  // A mitra may self-request a payout for their own reseller only
  // (ownership + balance enforced in the service, ADR-0010); admin/staff
  // may request for any reseller. Approve/reject/disburse stay
  // admin/staff-only — see below.
  @Roles('admin', 'staff', 'mitra')
  @Audit('reseller.payout.request')
  @Post(':id/payouts')
  @HttpCode(HttpStatus.CREATED)
  @ZodSerializerDto(PayoutResponseDto)
  requestPayout(
    @Param('id') id: string,
    @Body() body: CreatePayoutDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.resellers.requestPayout(id, body, user);
  }

  @Roles('admin', 'staff')
  @Audit('reseller.payout.approve')
  @Post(':id/payouts/:payoutId/approve')
  @ZodSerializerDto(PayoutResponseDto)
  approvePayout(
    @Param('id') id: string,
    @Param('payoutId') payoutId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.resellers.approvePayout(id, payoutId, user.id);
  }

  @Roles('admin', 'staff')
  @Audit('reseller.payout.reject')
  @Post(':id/payouts/:payoutId/reject')
  @ZodSerializerDto(PayoutResponseDto)
  rejectPayout(
    @Param('id') id: string,
    @Param('payoutId') payoutId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.resellers.rejectPayout(id, payoutId, user.id);
  }

  @Roles('admin', 'staff')
  @Audit('reseller.payout.disburse')
  @Post(':id/payouts/:payoutId/disburse')
  @ZodSerializerDto(PayoutResponseDto)
  disbursePayout(
    @Param('id') id: string,
    @Param('payoutId') payoutId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.resellers.disbursePayout(id, payoutId, user.id);
  }
}
