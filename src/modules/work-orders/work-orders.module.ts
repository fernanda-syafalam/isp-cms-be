import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { InventoryModule } from '../inventory/inventory.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { RouterResourcesModule } from '../router-resources/router-resources.module';
import { RoutersModule } from '../routers/routers.module';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersRepository } from './work-orders.repository';
import { WorkOrdersService } from './work-orders.service';

@Module({
  // The install cascade activates the customer (CustomersModule), consumes an
  // ONU (InventoryModule), provisions a PPPoE secret on the default router
  // (RoutersModule + RouterResourcesModule) and issues the first invoice
  // (InvoicesModule). None of these import work-orders, so there is no cycle.
  imports: [CustomersModule, InvoicesModule, InventoryModule, RoutersModule, RouterResourcesModule],
  controllers: [WorkOrdersController],
  providers: [WorkOrdersService, WorkOrdersRepository],
  // Exported so TicketsModule can dispatch a repair work order.
  exports: [WorkOrdersService, WorkOrdersRepository],
})
export class WorkOrdersModule {}
