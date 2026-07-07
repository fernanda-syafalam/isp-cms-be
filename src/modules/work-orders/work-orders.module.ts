import { Module, forwardRef } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { InventoryModule } from '../inventory/inventory.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RouterResourcesModule } from '../router-resources/router-resources.module';
import { RoutersModule } from '../routers/routers.module';
import { TicketsModule } from '../tickets/tickets.module';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersRepository } from './work-orders.repository';
import { WorkOrdersService } from './work-orders.service';

@Module({
  // The install cascade activates the customer (CustomersModule), consumes an
  // ONU (InventoryModule), provisions a PPPoE secret on the default router
  // (RoutersModule + RouterResourcesModule) and issues the first invoice
  // (InvoicesModule). InvoicesModule now imports SlaCreditsModule (P3.A.4),
  // which imports TicketsModule, which imports this module — closing a real
  // cycle, so this edge needs forwardRef() (else `InvoicesModule` is
  // undefined here at decoration time, see Nest's circular-dependency docs).
  //
  // TicketsModule also imports this module directly (to dispatch a repair
  // WO), and this module now needs TicketsService back (P3.B.4, to close the
  // repair loop on complete()) — another real cycle, forwardRef() on both
  // sides (see tickets.module.ts).
  imports: [
    CustomersModule,
    forwardRef(() => InvoicesModule),
    InventoryModule,
    RoutersModule,
    RouterResourcesModule,
    forwardRef(() => TicketsModule),
    // wo_scheduled/wo_done customer notices (ADR-0012 follow-up).
    NotificationsModule,
  ],
  controllers: [WorkOrdersController],
  providers: [WorkOrdersService, WorkOrdersRepository],
  // Exported so TicketsModule can dispatch a repair work order.
  exports: [WorkOrdersService, WorkOrdersRepository],
})
export class WorkOrdersModule {}
