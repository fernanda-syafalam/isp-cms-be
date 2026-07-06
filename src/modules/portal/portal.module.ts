import { Module } from '@nestjs/common';
import { AcsModule } from '../acs/acs.module';
import { AnnouncementsModule } from '../announcements/announcements.module';
import { CustomersModule } from '../customers/customers.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { TicketsModule } from '../tickets/tickets.module';
import { UsageModule } from '../usage/usage.module';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';

@Module({
  // Portal is a thin aggregator over the customer's own data: CustomersModule
  // (resolve subscriber + profile), InvoicesModule (invoices + payments),
  // TicketsModule (tickets + report-issue), UsageModule (data-usage/quota,
  // P3.C.4), AcsModule (WiFi SSID read/change seam, P3.C.4),
  // AnnouncementsModule (active announcements/outage feed, P3.C.4). All
  // export their services.
  imports: [
    CustomersModule,
    InvoicesModule,
    TicketsModule,
    UsageModule,
    AcsModule,
    AnnouncementsModule,
  ],
  controllers: [PortalController],
  providers: [PortalService],
})
export class PortalModule {}
