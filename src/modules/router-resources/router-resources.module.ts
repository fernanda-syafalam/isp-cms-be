import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { RoutersModule } from '../routers/routers.module';
import { ProfilesController } from './profiles.controller';
import { ProfilesRepository } from './profiles.repository';
import { ProfilesService } from './profiles.service';
import { SecretsController } from './secrets.controller';
import { SecretsRepository } from './secrets.repository';
import { SecretsService } from './secrets.service';

@Module({
  // RoutersModule for router existence + secretCount maintenance;
  // CustomersModule to resolve a secret's customer by name.
  imports: [RoutersModule, CustomersModule],
  controllers: [ProfilesController, SecretsController],
  providers: [ProfilesService, ProfilesRepository, SecretsService, SecretsRepository],
  exports: [ProfilesRepository, SecretsRepository],
})
export class RouterResourcesModule {}
