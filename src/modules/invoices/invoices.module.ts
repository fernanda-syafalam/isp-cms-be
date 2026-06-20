import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RouterResourcesModule } from '../router-resources/router-resources.module';
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
  // dispatched via the queue (ADR-0012).
  imports: [CustomersModule, RouterResourcesModule, NotificationsModule],
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
  exports: [InvoicesService, InvoicesRepository],
})
export class InvoicesModule {}
