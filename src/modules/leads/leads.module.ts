import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { PlansModule } from '../plans/plans.module';
import { WorkOrdersModule } from '../work-orders/work-orders.module';
import { LeadsController } from './leads.controller';
import { LeadsRepository } from './leads.repository';
import { LeadsService } from './leads.service';

@Module({
  // Conversion spans three modules: create a subscriber (Customers),
  // schedule the install (WorkOrders) and resolve the plan by name (Plans).
  imports: [CustomersModule, WorkOrdersModule, PlansModule, OnboardingModule],
  controllers: [LeadsController],
  providers: [LeadsService, LeadsRepository],
  exports: [LeadsService, LeadsRepository],
})
export class LeadsModule {}
