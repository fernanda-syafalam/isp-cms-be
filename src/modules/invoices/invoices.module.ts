import { Module, forwardRef } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ResellersModule } from '../resellers/resellers.module';
import { RouterResourcesModule } from '../router-resources/router-resources.module';
import { SettingsModule } from '../settings/settings.module';
import { SlaCreditsModule } from '../sla-credits/sla-credits.module';
import { BillingAutomationService } from './billing-automation.service';
import { BillingController } from './billing.controller';
import { InvoicesController } from './invoices.controller';
import { InvoicesRepository } from './invoices.repository';
import { InvoicesService } from './invoices.service';
import { PaymentIntentsController } from './payment-intents.controller';
import { PaymentIntentsRepository } from './payment-intents.repository';
import { PaymentIntentsService } from './payment-intents.service';
import { PaymentsController } from './payments.controller';

@Module({
  // CustomersModule exports CustomersRepository, which billing uses to
  // read active customers + plan price and to write the outstanding
  // balance / payment-driven reactivation. RouterResourcesModule exports
  // SecretsRepository so auto-isolir + payment reactivation enforce on the
  // PPPoE secret (ADR-0008); it does not import invoices, so no cycle.
  // NotificationsModule exports NotificationsService so dunning is actually
  // dispatched via the queue (ADR-0012). SettingsModule exports SettingsService
  // so tax/due-days/late-fee come from admin-editable settings (P2.3); it does
  // not import invoices, so no cycle. SlaCreditsModule exports
  // SlaCreditsRepository so a billing run can absorb a customer's pending
  // SLA credits into the new invoice's discount line (P3.A.4) — but it
  // imports TicketsModule -> WorkOrdersModule -> InvoicesModule, closing a
  // real cycle, so this one edge needs forwardRef() (Nest docs: circular
  // module imports leave one side's class undefined at decoration time
  // otherwise).
  imports: [
    CustomersModule,
    RouterResourcesModule,
    NotificationsModule,
    SettingsModule,
    ResellersModule,
    forwardRef(() => SlaCreditsModule),
  ],
  controllers: [
    InvoicesController,
    PaymentsController,
    PaymentIntentsController,
    BillingController,
  ],
  providers: [
    InvoicesService,
    InvoicesRepository,
    BillingAutomationService,
    PaymentIntentsService,
    PaymentIntentsRepository,
  ],
  // PaymentIntentsService is exported for the portal's customer-scoped
  // pay-intent endpoints (P0.4). BillingAutomationService + InvoicesService
  // + PaymentIntentsService are also driven by the scheduler (P2.1).
  exports: [InvoicesService, InvoicesRepository, PaymentIntentsService, BillingAutomationService],
})
export class InvoicesModule {}
