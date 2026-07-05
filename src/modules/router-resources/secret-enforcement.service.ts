import { Injectable, Logger } from '@nestjs/common';
import { RouterAdapter } from './adapters/router-adapter';
import { SecretsRepository } from './secrets.repository';

/**
 * Single entry point for billing-lifecycle network enforcement (P2.5,
 * ADR-0008). Writes the `disabled` flag on every PPPoE secret a customer owns
 * (the DB source of truth) and then pushes that state to each secret's router
 * via the configured adapter (`simulation` no-op by default, `live` RouterOS
 * in production). The push is best-effort — the adapter swallows per-router
 * failures — so a billing batch is never aborted by one unreachable device.
 *
 * Callers (customers lifecycle, billing auto-isolir) use this instead of the
 * repository directly so DB and device never drift.
 */
@Injectable()
export class SecretEnforcementService {
  private readonly logger = new Logger(SecretEnforcementService.name);

  constructor(
    private readonly repo: SecretsRepository,
    private readonly adapter: RouterAdapter,
  ) {}

  /**
   * Apply `disabled` to all of the customer's PPPoE secrets (DB + device).
   * No-op and returns 0 when the customer has no secret yet (prospek/instalasi),
   * so callers never guard on it. Returns how many secrets were affected.
   */
  async applyDisabledForCustomer(customerId: string, disabled: boolean): Promise<number> {
    const targets = await this.repo.findRouterTargetsByCustomerId(customerId);
    const count = await this.repo.setDisabledByCustomerId(customerId, disabled);
    for (const target of targets) {
      await this.adapter.setSecretDisabled(
        {
          host: target.host,
          apiPort: target.apiPort,
          routerUser: target.routerUser,
          secretUsername: target.secretUsername,
        },
        disabled,
      );
    }
    if (count > 0) {
      this.logger.log({ customerId, disabled, count }, 'enforced secret disabled state');
    }
    return count;
  }
}
