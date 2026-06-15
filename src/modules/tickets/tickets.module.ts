import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { WorkOrdersModule } from '../work-orders/work-orders.module';
import { TicketsController } from './tickets.controller';
import { TicketsRepository } from './tickets.repository';
import { TicketsService } from './tickets.service';

@Module({
  // CustomersModule resolves the subscriber id from the ticket's customer
  // name; WorkOrdersModule dispatches a repair work order from a ticket.
  imports: [CustomersModule, WorkOrdersModule],
  controllers: [TicketsController],
  providers: [TicketsService, TicketsRepository],
  exports: [TicketsService, TicketsRepository],
})
export class TicketsModule {}
