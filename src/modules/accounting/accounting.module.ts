import { Module } from '@nestjs/common';
import { InvoicesModule } from '../invoices/invoices.module';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';

@Module({
  // The journal is derived from settled invoices (InvoicesRepository).
  // No accounting table — entries are computed on read.
  imports: [InvoicesModule],
  controllers: [AccountingController],
  providers: [AccountingService],
  exports: [AccountingService],
})
export class AccountingModule {}
