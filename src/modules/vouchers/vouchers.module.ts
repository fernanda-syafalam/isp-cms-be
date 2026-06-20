import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { VouchersController } from './vouchers.controller';
import { VouchersRepository } from './vouchers.repository';
import { VouchersService } from './vouchers.service';

@Module({
  // CustomersModule exports CustomersRepository so a loket sale can resolve the
  // buyer and credit their outstanding balance (ADR-0010).
  imports: [CustomersModule],
  controllers: [VouchersController],
  providers: [VouchersService, VouchersRepository],
  exports: [VouchersService, VouchersRepository],
})
export class VouchersModule {}
