import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { UsersModule } from '../users/users.module';
import { WorkOrdersModule } from '../work-orders/work-orders.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({
  // Onboarding orchestrates three owning modules: UsersModule (provisions
  // the portal login, P1.3), CustomersModule (creates the subscriber) and
  // WorkOrdersModule (schedules the install). None imports onboarding, so
  // there is no cycle. Leaf aggregator — nothing to export.
  imports: [CustomersModule, WorkOrdersModule, UsersModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
