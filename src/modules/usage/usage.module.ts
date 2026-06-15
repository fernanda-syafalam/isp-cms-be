import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';

@Module({
  // Reads provisioned subscribers + plan speed from CustomersRepository.
  // No usage table — the list is computed on read.
  imports: [CustomersModule],
  controllers: [UsageController],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
