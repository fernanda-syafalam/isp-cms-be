import { Module } from '@nestjs/common';
import { AcsController } from './acs.controller';
import { AcsRepository } from './acs.repository';
import { AcsService } from './acs.service';

@Module({
  controllers: [AcsController],
  providers: [AcsService, AcsRepository],
  exports: [AcsService, AcsRepository],
})
export class AcsModule {}
