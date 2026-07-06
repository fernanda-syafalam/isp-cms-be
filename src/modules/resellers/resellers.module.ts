import { Module, forwardRef } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { ResellersController } from './resellers.controller';
import { ResellersRepository } from './resellers.repository';
import { ResellersService } from './resellers.service';

@Module({
  // Derives customerCount from customers linked by resellerId (FK).
  // CustomersModule imports this module back (P3.D.2: validating the
  // resellerId FK on onboard), so the edge uses forwardRef to break the
  // module-import cycle.
  imports: [forwardRef(() => CustomersModule)],
  controllers: [ResellersController],
  providers: [ResellersService, ResellersRepository],
  exports: [ResellersService, ResellersRepository],
})
export class ResellersModule {}
