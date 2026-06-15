import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { TicketsController } from './tickets.controller';
import { TicketsRepository } from './tickets.repository';
import { TicketsService } from './tickets.service';

@Module({
  // CustomersModule exports CustomersRepository, used to resolve the
  // subscriber id from the ticket's customer name.
  imports: [CustomersModule],
  controllers: [TicketsController],
  providers: [TicketsService, TicketsRepository],
  exports: [TicketsService, TicketsRepository],
})
export class TicketsModule {}
