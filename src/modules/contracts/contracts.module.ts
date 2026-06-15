import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { ContractsController } from './contracts.controller';
import { ContractsRepository } from './contracts.repository';
import { ContractsService } from './contracts.service';

@Module({
  // Reads the customer to snapshot name + plan onto a new contract.
  imports: [CustomersModule],
  controllers: [ContractsController],
  providers: [ContractsService, ContractsRepository],
  exports: [ContractsService, ContractsRepository],
})
export class ContractsModule {}
