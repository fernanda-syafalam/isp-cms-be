import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SettingsResponseDto } from './dto/settings-response.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SettingsService } from './settings.service';

@Controller({ path: 'settings', version: '1' })
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  // Any authenticated user may read settings (invoices/print need company +
  // tax data).
  @Get()
  @ZodSerializerDto(SettingsResponseDto)
  get() {
    return this.settings.get();
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
