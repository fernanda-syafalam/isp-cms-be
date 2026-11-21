import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { PlansModule } from '../plans/plans.module';
import { RouterResourcesModule } from '../router-resources/router-resources.module';
import { RoutersModule } from '../routers/routers.module';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';
import { WorkOrdersModule } from '../work-orders/work-orders.module';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';

@Module({
  // Read-only aggregator: imports the seven owning modules to reach their
  // repositories. None of them depends on setup, so there is no cycle.
  // Leaf module — nothing to export.
  imports: [
    PlansModule,
    RoutersModule,
    RouterResourcesModule,
    SettingsModule,
    UsersModule,
    CustomersModule,
    WorkOrdersModule,
  ],
  controllers: [SetupController],
  providers: [SetupService],
})
export class SetupModule {}
