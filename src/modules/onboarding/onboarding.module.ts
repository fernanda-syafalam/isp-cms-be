import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { WorkOrdersModule } from '../work-orders/work-orders.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({
  // Onboarding orchestrates two owning modules: CustomersModule (creates the
  // subscriber) and WorkOrdersModule (schedules the install). Neither imports
  // onboarding, so there is no cycle. Leaf aggregator — nothing to export.
  imports: [CustomersModule, WorkOrdersModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
