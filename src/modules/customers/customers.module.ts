import { Module, forwardRef } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlansModule } from '../plans/plans.module';
import { ResellersModule } from '../resellers/resellers.module';
import { RouterResourcesModule } from '../router-resources/router-resources.module';
import { SettingsModule } from '../settings/settings.module';
import { CustomersController } from './customers.controller';
import { CustomersRepository } from './customers.repository';
import { CustomersService } from './customers.service';

@Module({
  // PlansModule exports PlansRepository (plan FK validation + price for
  // proration); it now also reads CustomersRepository back (PlansService,
  // to enrich the plan-list summary's `totalSubscribers`), so this edge
  // needs forwardRef() on both sides (see plans.module.ts).
  // NotificationsModule exports NotificationsService (WhatsApp
  // dunning). RouterResourcesModule exports SecretsRepository so lifecycle
  // transitions can enforce isolir on the PPPoE secret (ADR-0008); it imports
  // CustomersModule back (resolves a secret's customer), so the edge uses
  // forwardRef to break the module-import cycle. ResellersModule exports
  // ResellersRepository (validates the resellerId FK on onboard, P3.D.2); it
  // also imports CustomersModule back (customerCount derivation), same
  // forwardRef treatment. SettingsModule exports SettingsService — changePlan
  // reads the billing policy's dueDays so a proration adjustment invoice gets
  // the same grace period as a regular invoice (MED #4, PR #121 review); it
  // is a leaf module (no imports back), so a plain import is enough.
  imports: [
    forwardRef(() => PlansModule),
    NotificationsModule,
    forwardRef(() => RouterResourcesModule),
    forwardRef(() => ResellersModule),
    SettingsModule,
  ],
  controllers: [CustomersController],
  providers: [CustomersService, CustomersRepository],
  exports: [CustomersService, CustomersRepository],
})
export class CustomersModule {}
