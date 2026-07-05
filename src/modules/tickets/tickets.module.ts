import { Module, forwardRef } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { WorkOrdersModule } from '../work-orders/work-orders.module';
import { TicketsController } from './tickets.controller';
import { TicketsRepository } from './tickets.repository';
import { TicketsService } from './tickets.service';

@Module({
  // CustomersModule resolves the subscriber id from the ticket's customer
  // name; WorkOrdersModule dispatches a repair work order from a ticket and
  // (P3.B.4) calls back into TicketsService to close the loop on complete —
  // a real cycle, so this edge needs forwardRef() on both sides (see
  // work-orders.module.ts).
  imports: [CustomersModule, forwardRef(() => WorkOrdersModule)],
  controllers: [TicketsController],
  providers: [TicketsService, TicketsRepository],
  exports: [TicketsService, TicketsRepository],
})
export class TicketsModule {}
