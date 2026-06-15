import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { InventoryController } from './inventory.controller';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';

@Module({
  // CustomersModule resolves the subscriber id from the assigned name.
  imports: [CustomersModule],
  controllers: [InventoryController],
  providers: [InventoryService, InventoryRepository],
  exports: [InventoryService, InventoryRepository],
})
export class InventoryModule {}
