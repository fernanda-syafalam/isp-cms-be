import { Module } from '@nestjs/common';
import { VouchersController } from './vouchers.controller';
import { VouchersRepository } from './vouchers.repository';
import { VouchersService } from './vouchers.service';

@Module({
  controllers: [VouchersController],
  providers: [VouchersService, VouchersRepository],
  exports: [VouchersService, VouchersRepository],
})
export class VouchersModule {}
