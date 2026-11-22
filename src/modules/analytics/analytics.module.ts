import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { SlaCreditsModule } from '../sla-credits/sla-credits.module';
import { TicketsModule } from '../tickets/tickets.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  // Read-only aggregator: imports the four owning modules to reach their
  // repositories. None of them depends on analytics, so there is no cycle.
  // Leaf module — nothing to export.
  imports: [CustomersModule, InvoicesModule, TicketsModule, SlaCreditsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
