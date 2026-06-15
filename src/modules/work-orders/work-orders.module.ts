import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersRepository } from './work-orders.repository';
import { WorkOrdersService } from './work-orders.service';

@Module({
  // The install cascade activates the customer (CustomersModule) and
  // issues the first invoice (InvoicesModule).
  imports: [CustomersModule, InvoicesModule],
  controllers: [WorkOrdersController],
  providers: [WorkOrdersService, WorkOrdersRepository],
  // Exported so TicketsModule can dispatch a repair work order.
  exports: [WorkOrdersService, WorkOrdersRepository],
})
export class WorkOrdersModule {}
