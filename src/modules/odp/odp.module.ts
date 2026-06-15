import { Module } from '@nestjs/common';
import { OdpController } from './odp.controller';
import { OdpRepository } from './odp.repository';
import { OdpService } from './odp.service';

@Module({
  controllers: [OdpController],
  providers: [OdpService, OdpRepository],
  exports: [OdpService],
})
export class OdpModule {}
