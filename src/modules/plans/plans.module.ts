import { Module } from '@nestjs/common';
import { PlansController } from './plans.controller';
import { PlansRepository } from './plans.repository';
import { PlansService } from './plans.service';

@Module({
  controllers: [PlansController],
  providers: [PlansService, PlansRepository],
  // Exported so future modules (customers, invoices) can resolve a plan
  // without re-querying the table directly.
  exports: [PlansService, PlansRepository],
})
export class PlansModule {}
