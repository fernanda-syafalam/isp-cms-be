import { Module, forwardRef } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlansModule } from '../plans/plans.module';
import { ResellersModule } from '../resellers/resellers.module';
import { RouterResourcesModule } from '../router-resources/router-resources.module';
import { CustomersController } from './customers.controller';
import { CustomersRepository } from './customers.repository';
import { CustomersService } from './customers.service';

@Module({
  // PlansModule exports PlansRepository (plan FK validation + price for
  // proration); NotificationsModule exports NotificationsService (WhatsApp
  // dunning). RouterResourcesModule exports SecretsRepository so lifecycle
  // transitions can enforce isolir on the PPPoE secret (ADR-0008); it imports
  // CustomersModule back (resolves a secret's customer), so the edge uses
  // forwardRef to break the module-import cycle. ResellersModule exports
  // ResellersRepository (validates the resellerId FK on onboard, P3.D.2); it
  // also imports CustomersModule back (customerCount derivation), same
  // forwardRef treatment.
  imports: [
    PlansModule,
    NotificationsModule,
    forwardRef(() => RouterResourcesModule),
    forwardRef(() => ResellersModule),
  ],
  controllers: [CustomersController],
  providers: [CustomersService, CustomersRepository],
  exports: [CustomersService, CustomersRepository],
})
export class CustomersModule {}
