import { Module, forwardRef } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WorkOrdersModule } from '../work-orders/work-orders.module';
import { TicketsController } from './tickets.controller';
import { TicketsRepository } from './tickets.repository';
import { TicketsService } from './tickets.service';

@Module({
  // CustomersModule resolves the subscriber id from the ticket's customer
  // name (and its phone, for the ticket_update notice); WorkOrdersModule
  // dispatches a repair work order from a ticket and (P3.B.4) calls back
  // into TicketsService to close the loop on complete — a real cycle, so
  // this edge needs forwardRef() on both sides (see work-orders.module.ts).
  // NotificationsModule exports NotificationsService so a status change
  // fires the ticket_update event via the queue (ADR-0012).
  imports: [CustomersModule, NotificationsModule, forwardRef(() => WorkOrdersModule)],
  controllers: [TicketsController],
  providers: [TicketsService, TicketsRepository],
  exports: [TicketsService, TicketsRepository],
})
export class TicketsModule {}
