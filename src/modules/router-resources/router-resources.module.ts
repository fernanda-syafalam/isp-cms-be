import { Module, forwardRef } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { RoutersModule } from '../routers/routers.module';
import { PoolsController } from './pools.controller';
import { PoolsRepository } from './pools.repository';
import { PoolsService } from './pools.service';
import { ProfilesController } from './profiles.controller';
import { ProfilesRepository } from './profiles.repository';
import { ProfilesService } from './profiles.service';
import { QueuesController } from './queues.controller';
import { QueuesRepository } from './queues.repository';
import { QueuesService } from './queues.service';
import { SecretsController } from './secrets.controller';
import { SecretsRepository } from './secrets.repository';
import { SecretsService } from './secrets.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  // RoutersModule for router existence + secretCount maintenance;
  // CustomersModule to resolve a secret's customer by name. CustomersModule
  // imports this module back (lifecycle isolir enforcement, ADR-0008), so the
  // edge uses forwardRef to break the module-import cycle.
  imports: [RoutersModule, forwardRef(() => CustomersModule)],
  controllers: [
    ProfilesController,
    SecretsController,
    QueuesController,
    PoolsController,
    SessionsController,
  ],
  providers: [
    ProfilesService,
    ProfilesRepository,
    SecretsService,
    SecretsRepository,
    QueuesService,
    QueuesRepository,
    PoolsService,
    PoolsRepository,
    SessionsService,
  ],
  exports: [ProfilesRepository, SecretsRepository, QueuesRepository, PoolsRepository],
})
export class RouterResourcesModule {}
