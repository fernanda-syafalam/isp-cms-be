import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlansModule } from '../plans/plans.module';
import { CustomersController } from './customers.controller';
import { CustomersRepository } from './customers.repository';
import { CustomersService } from './customers.service';

@Module({
  // PlansModule exports PlansRepository (plan FK validation + price for
  // proration); NotificationsModule exports NotificationsService (WhatsApp
  // dunning). Neither imports customers, so there is no cycle.
  imports: [PlansModule, NotificationsModule],
  controllers: [CustomersController],
  providers: [CustomersService, CustomersRepository],
  exports: [CustomersService, CustomersRepository],
})
export class CustomersModule {}
