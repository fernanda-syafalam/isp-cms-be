import { Module, forwardRef } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { PlansController } from './plans.controller';
import { PlansRepository } from './plans.repository';
import { PlansService } from './plans.service';

@Module({
  // PlansService reads CustomersRepository.countByStatus() to enrich the
  // list summary with `totalSubscribers` (FE contract parity). CustomersModule
  // already imports PlansModule directly (plan FK validation), so this edge
  // needs forwardRef() on both sides (mirrors resellers.module.ts /
  // customers.module.ts).
  imports: [forwardRef(() => CustomersModule)],
  controllers: [PlansController],
  providers: [PlansService, PlansRepository],
  // Exported so future modules (customers, invoices) can resolve a plan
  // without re-querying the table directly.
  exports: [PlansService, PlansRepository],
})
export class PlansModule {}
