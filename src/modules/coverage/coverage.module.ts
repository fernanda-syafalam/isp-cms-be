import { Module } from '@nestjs/common';
import { CoverageController } from './coverage.controller';
import { CoverageRepository } from './coverage.repository';
import { CoverageService } from './coverage.service';

@Module({
  controllers: [CoverageController],
  providers: [CoverageService, CoverageRepository],
  exports: [CoverageService, CoverageRepository],
})
export class CoverageModule {}
