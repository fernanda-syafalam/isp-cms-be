import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { TicketsModule } from '../tickets/tickets.module';
import { SlaCreditsController } from './sla-credits.controller';
import { SlaCreditsRepository } from './sla-credits.repository';
import { SlaCreditsService } from './sla-credits.service';

@Module({
  // Resolve the customer id (by name) and ticket id (by code) on create.
  imports: [CustomersModule, TicketsModule],
  controllers: [SlaCreditsController],
  providers: [SlaCreditsService, SlaCreditsRepository],
  exports: [SlaCreditsService, SlaCreditsRepository],
})
export class SlaCreditsModule {}
