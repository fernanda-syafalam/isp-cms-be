import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { TicketsModule } from '../tickets/tickets.module';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';

@Module({
  // Portal is a thin aggregator over the customer's own data: CustomersModule
  // (resolve subscriber + profile), InvoicesModule (invoices + payments),
  // TicketsModule (tickets + report-issue). All three export their services.
  imports: [CustomersModule, InvoicesModule, TicketsModule],
  controllers: [PortalController],
  providers: [PortalService],
})
export class PortalModule {}
