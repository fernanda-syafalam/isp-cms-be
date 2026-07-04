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
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { ChangePlanDto, RelocateDto, SetOnuWifiDto } from './dto/customer-actions.dto';
import { CustomerResponseDto } from './dto/customer-response.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { UpdateKycDto } from './dto/update-kyc.dto';

// Query params for the list endpoint. The global ZodValidationPipe does
// not validate plain query objects, so parse here (same pattern as the
// users cursor query).
const ListQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  status: z.enum(['prospek', 'instalasi', 'aktif', 'isolir', 'berhenti']).optional(),
  // Repeatable: ?area=Jepara&area=Tahunan — a single string is coerced to
  // a one-element array so callers need not special-case the scalar case.
  area: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@Roles('admin', 'staff')
@Controller({ path: 'customers', version: '1' })
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  // Staff read the whole subscriber base; a mitra principal reads only
  // their own reseller's acquisitions (scoped server-side, P1.5).
  @Roles('admin', 'staff', 'mitra')
  @Get()
  list(@Query() query: unknown, @CurrentUser() user: AuthUser) {
    const filter = ListQuerySchema.parse(query);
    return this.customers.list(filter, user);
  }

  @Get(':id')
  @ZodSerializerDto(CustomerResponseDto)
  findOne(@Param('id') id: string) {
    return this.customers.findById(id);
  }

  // Operations + billing staff create and edit customers, not just admin.
  @Roles('admin', 'staff')
  @Audit('customer.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ZodSerializerDto(CustomerResponseDto)
  create(@Body() body: CreateCustomerDto) {
    return this.customers.create(body);
  }

  @Roles('admin', 'staff')
  @Audit('customer.update')
  @Patch(':id')
  @ZodSerializerDto(CustomerResponseDto)
  update(@Param('id') id: string, @Body() body: UpdateCustomerDto) {
    return this.customers.update(id, body);
  }

  // --- Lifecycle ------------------------------------------------------

  @Roles('admin', 'staff')
  @Audit('customer.suspend')
  @Post(':id/suspend')
  @ZodSerializerDto(CustomerResponseDto)
  suspend(@Param('id') id: string) {
    return this.customers.suspend(id);
  }

  @Roles('admin', 'staff')
  @Audit('customer.resume')
  @Post(':id/resume')
  @ZodSerializerDto(CustomerResponseDto)
  resume(@Param('id') id: string) {
    return this.customers.resume(id);
  }

  @Roles('admin', 'staff')
  @Audit('customer.isolate')
  @Post(':id/isolate')
  @ZodSerializerDto(CustomerResponseDto)
  isolate(@Param('id') id: string) {
    return this.customers.isolate(id);
  }

  @Roles('admin', 'staff')
  @Audit('customer.activate')
  @Post(':id/activate')
  @ZodSerializerDto(CustomerResponseDto)
  activate(@Param('id') id: string) {
    return this.customers.activate(id);
  }

  @Roles('admin', 'staff')
  @Audit('customer.stop')
  @Post(':id/stop')
  @ZodSerializerDto(CustomerResponseDto)
  stop(@Param('id') id: string) {
    return this.customers.stop(id);
  }

  // --- Compliance (UU PDP) --------------------------------------------

  @Roles('admin', 'staff')
  @Audit('customer.consent')
  @Post(':id/consent')
  @ZodSerializerDto(CustomerResponseDto)
  consent(@Param('id') id: string) {
    return this.customers.recordConsent(id);
  }

  @Roles('admin', 'staff')
  @Audit('customer.kyc')
  @Patch(':id/kyc')
  @ZodSerializerDto(CustomerResponseDto)
  updateKyc(@Param('id') id: string, @Body() body: UpdateKycDto) {
    return this.customers.updateKyc(id, body);
  }

  // Erasure request — acknowledged with 202; an async worker performs
  // the actual anonymization out of band.
  @Roles('admin', 'staff')
  @Audit('customer.data_deletion')
  @Post(':id/data-deletion')
  @HttpCode(HttpStatus.ACCEPTED)
  requestDataDeletion(@Param('id') id: string): Promise<void> {
    return this.customers.requestDataDeletion(id);
  }

  // --- Subscriber actions ---------------------------------------------

  @Roles('admin', 'staff')
  @Audit('customer.relocate')
  @Post(':id/relocate')
  @ZodSerializerDto(CustomerResponseDto)
  relocate(@Param('id') id: string, @Body() body: RelocateDto) {
    return this.customers.relocate(id, body);
  }

  @Roles('admin', 'staff')
  @Audit('customer.change_plan')
  @Post(':id/change-plan')
  @ZodSerializerDto(CustomerResponseDto)
  changePlan(@Param('id') id: string, @Body() body: ChangePlanDto) {
    return this.customers.changePlan(id, body);
  }

  @Roles('admin', 'staff', 'teknisi')
  @Audit('customer.onu_reboot')
  @Post(':id/onu/reboot')
  @ZodSerializerDto(CustomerResponseDto)
  rebootOnu(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.customers.rebootOnu(id, user);
  }

  @Roles('admin', 'staff', 'teknisi')
  @Audit('customer.onu_wifi')
  @Post(':id/onu/wifi')
  @ZodSerializerDto(CustomerResponseDto)
  setOnuWifi(@Param('id') id: string, @Body() body: SetOnuWifiDto, @CurrentUser() user: AuthUser) {
    return this.customers.setOnuWifi(id, body, user);
  }

  @Roles('admin', 'staff')
  @Audit('customer.notify_whatsapp')
  @Post(':id/notify/whatsapp')
  @ZodSerializerDto(CustomerResponseDto)
  notifyWhatsapp(@Param('id') id: string) {
    return this.customers.notifyWhatsapp(id);
  }
}
