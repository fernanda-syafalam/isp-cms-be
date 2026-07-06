import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { ResellersModule } from '../resellers/resellers.module';
import { VouchersController } from './vouchers.controller';
import { VouchersRepository } from './vouchers.repository';
import { VouchersService } from './vouchers.service';

@Module({
  // CustomersModule exports CustomersRepository so a loket sale can resolve
  // the buyer and credit their outstanding balance (ADR-0010). ResellersModule
  // is imported for DI wiring symmetry with the rest of the app even though
  // VouchersRepository.settle() writes the reseller_ledger/resellers tables
  // directly (P3.D.3) rather than through ResellersRepository — see the
  // comment on `settle()` for why that write must share one transaction.
  imports: [CustomersModule, ResellersModule],
  controllers: [VouchersController],
  providers: [VouchersService, VouchersRepository],
  exports: [VouchersService, VouchersRepository],
})
export class VouchersModule {}
