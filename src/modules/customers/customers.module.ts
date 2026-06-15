import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module';
import { CustomersController } from './customers.controller';
import { CustomersRepository } from './customers.repository';
import { CustomersService } from './customers.service';

@Module({
  // PlansModule exports PlansRepository, which the service uses to
  // validate the plan FK before creating/updating a customer.
  imports: [PlansModule],
  controllers: [CustomersController],
  providers: [CustomersService, CustomersRepository],
  exports: [CustomersService, CustomersRepository],
})
export class CustomersModule {}
