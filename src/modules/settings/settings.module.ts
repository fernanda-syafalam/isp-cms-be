import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsRepository } from './settings.repository';
import { SettingsService } from './settings.service';

@Module({
  controllers: [SettingsController],
  providers: [SettingsService, SettingsRepository],
  // Exported so billing/invoices can later read PKP / tax-rate / grace days
  // from here instead of hardcoded constants.
  exports: [SettingsService, SettingsRepository],
})
export class SettingsModule {}
