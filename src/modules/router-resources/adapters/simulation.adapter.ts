import { Injectable, Logger } from '@nestjs/common';
import { RouterAdapter, type RouterSecretTarget } from './router-adapter';

/**
 * Default enforcement mode (dev/test/`ROUTEROS_MODE=simulation`). The DB flag
 * written by SecretsRepository is the whole effect; this adapter only records
 * that a push *would* have happened, so the isolir→secret behaviour is fully
 * observable offline without a real Mikrotik.
 */
@Injectable()
export class SimulationRouterAdapter extends RouterAdapter {
  private readonly logger = new Logger(SimulationRouterAdapter.name);

  async setSecretDisabled(target: RouterSecretTarget, disabled: boolean): Promise<void> {
    this.logger.log(
      { host: target.host, secret: target.secretUsername, disabled },
      'simulation: would set PPPoE secret disabled state on router',
    );
  }
}
