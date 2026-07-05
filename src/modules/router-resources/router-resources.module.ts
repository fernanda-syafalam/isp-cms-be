import { Module, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { CustomersModule } from '../customers/customers.module';
import { RoutersModule } from '../routers/routers.module';
import { RouterAdapter } from './adapters/router-adapter';
import { RouterOsRouterAdapter } from './adapters/routeros.adapter';
import { SimulationRouterAdapter } from './adapters/simulation.adapter';
import { PoolsController } from './pools.controller';
import { PoolsRepository } from './pools.repository';
import { PoolsService } from './pools.service';
import { ProfilesController } from './profiles.controller';
import { ProfilesRepository } from './profiles.repository';
import { ProfilesService } from './profiles.service';
import { QueuesController } from './queues.controller';
import { QueuesRepository } from './queues.repository';
import { QueuesService } from './queues.service';
import { SecretEnforcementService } from './secret-enforcement.service';
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
    SecretEnforcementService,
    QueuesService,
    QueuesRepository,
    PoolsService,
    PoolsRepository,
    SessionsService,
    // Select the enforcement adapter by ROUTEROS_MODE (P2.5): 'live' pushes to
    // the real RouterOS device; 'simulation' (default) is a DB-only no-op.
    SimulationRouterAdapter,
    RouterOsRouterAdapter,
    {
      provide: RouterAdapter,
      inject: [ConfigService, SimulationRouterAdapter, RouterOsRouterAdapter],
      useFactory: (
        config: ConfigService<{ app: AppConfig }, true>,
        simulation: SimulationRouterAdapter,
        live: RouterOsRouterAdapter,
      ) => (config.get('app.routeros.mode', { infer: true }) === 'live' ? live : simulation),
    },
  ],
  exports: [
    ProfilesRepository,
    SecretsRepository,
    SecretEnforcementService,
    QueuesRepository,
    PoolsRepository,
  ],
})
export class RouterResourcesModule {}
