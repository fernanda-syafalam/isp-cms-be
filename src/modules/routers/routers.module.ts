import { Module } from '@nestjs/common';
import { RoutersController } from './routers.controller';
import { RoutersRepository } from './routers.repository';
import { RoutersService } from './routers.service';

@Module({
  controllers: [RoutersController],
  providers: [RoutersService, RoutersRepository],
  // Exported so the PPPoE-secrets module (next) can maintain secretCount.
  exports: [RoutersService, RoutersRepository],
})
export class RoutersModule {}
