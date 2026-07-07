import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { AnyAuthenticatedRole } from '../../common/decorators/any-authenticated-role.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PublicSettingsResponseDto } from './dto/public-settings-response.dto';
import { SettingsResponseDto } from './dto/settings-response.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SettingsService } from './settings.service';

@Controller({ path: 'settings', version: '1' })
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  // SEC-3: the full blob (incl. the billing-policy section: late fee, due
  // days, isolir grace days) is operational config for admins only — it is
  // NOT needed to render an invoice/receipt. Staff/customer must use
  // GET /v1/settings/public below.
  @Roles('admin')
  @Get()
  @ZodSerializerDto(SettingsResponseDto)
  get() {
    return this.settings.get();
  }

  // SEC-3: the invoice-needed subset (company identity + tax fields) —
  // any authenticated role may read this (the customer portal and the
  // staff invoice-print view both render a FAKTUR/KWITANSI from it).
  @AnyAuthenticatedRole()
  @Get('public')
  @ZodSerializerDto(PublicSettingsResponseDto)
  getPublic() {
    return this.settings.getPublic();
  }

  // Editing company / billing / tax config is admin-only.
  @Roles('admin')
  @Audit('settings.update')
  @Patch()
  @ZodSerializerDto(SettingsResponseDto)
  update(@Body() body: UpdateSettingsDto) {
    return this.settings.update(body);
  }
}
