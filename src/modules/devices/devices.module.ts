import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { DevicesRepository } from './devices.repository';
import { DevicesService } from './devices.service';

@Module({
  controllers: [DevicesController],
  providers: [DevicesService, DevicesRepository],
  // Exported so the analytics module can read fleet health (online/total).
  exports: [DevicesService, DevicesRepository],
})
export class DevicesModule {}
