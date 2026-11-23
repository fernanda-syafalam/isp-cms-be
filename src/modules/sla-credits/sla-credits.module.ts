import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { TicketsModule } from '../tickets/tickets.module';
import { SlaCreditsRepository } from './sla-credits.repository';
import { SlaCreditsService } from './sla-credits.service';

@Module({
  // Resolve the customer id (by name) and ticket id (by code) on create.
  imports: [CustomersModule, TicketsModule],
  // No controllers: the SLA-credit HTTP routes are closed for the MVP (re-add SlaCreditsController for v1.1);
  // the repository stays provided so billing keeps absorbing proration credits.
  providers: [SlaCreditsService, SlaCreditsRepository],
  exports: [SlaCreditsService, SlaCreditsRepository],
})
export class SlaCreditsModule {}
