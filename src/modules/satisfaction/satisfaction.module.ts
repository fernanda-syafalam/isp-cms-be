import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { TicketsModule } from '../tickets/tickets.module';
import { SatisfactionController } from './satisfaction.controller';
import { SatisfactionService } from './satisfaction.service';

@Module({
  // Aggregates from customers (churn / NPS) and tickets (CSAT / feedback).
  // No satisfaction table — the summary is computed on read.
  imports: [CustomersModule, TicketsModule],
  controllers: [SatisfactionController],
  providers: [SatisfactionService],
  exports: [SatisfactionService],
})
export class SatisfactionModule {}
