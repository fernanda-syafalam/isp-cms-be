import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { ResellersController } from './resellers.controller';
import { ResellersRepository } from './resellers.repository';
import { ResellersService } from './resellers.service';

@Module({
  // Derives customerCount from customers linked by reseller name.
  imports: [CustomersModule],
  controllers: [ResellersController],
  providers: [ResellersService, ResellersRepository],
  exports: [ResellersService, ResellersRepository],
})
export class ResellersModule {}
