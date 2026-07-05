import { Module } from '@nestjs/common';
import { ContractsModule } from '../contracts/contracts.module';
import { CoverageModule } from '../coverage/coverage.module';
import { CustomersModule } from '../customers/customers.module';
import { OdpModule } from '../odp/odp.module';
import { UsersModule } from '../users/users.module';
import { WorkOrdersModule } from '../work-orders/work-orders.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({
  // Onboarding orchestrates six owning modules: UsersModule (provisions the
  // portal login, P1.3), CoverageModule (serviceability gate), OdpModule
  // (atomic port reservation), CustomersModule (creates the subscriber),
  // WorkOrdersModule (schedules the install) and ContractsModule (auto-draft
  // PKS, P3.A.1). None of these import onboarding, so there is no cycle.
  // Leaf aggregator — nothing to export beyond OnboardingService itself.
  imports: [
    CustomersModule,
    WorkOrdersModule,
    UsersModule,
    CoverageModule,
    OdpModule,
    ContractsModule,
  ],
  controllers: [OnboardingController],
  providers: [OnboardingService],
  // Exported so LeadsModule can route lead conversion through the single
  // onboarding acquisition path (P3.A.2).
  exports: [OnboardingService],
})
export class OnboardingModule {}
