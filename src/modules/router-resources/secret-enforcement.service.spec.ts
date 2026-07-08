import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouterAdapter } from './adapters/router-adapter';
import { SecretEnforcementService } from './secret-enforcement.service';
import type { SecretsRepository } from './secrets.repository';

describe('SecretEnforcementService', () => {
  let repo: {
    findRouterTargetsByCustomerId: ReturnType<typeof vi.fn>;
    setDisabledByCustomerId: ReturnType<typeof vi.fn>;
  };
  let adapter: { setSecretDisabled: ReturnType<typeof vi.fn> };
  let service: SecretEnforcementService;

  beforeEach(() => {
    repo = {
      findRouterTargetsByCustomerId: vi.fn(),
      setDisabledByCustomerId: vi.fn(),
    };
    adapter = { setSecretDisabled: vi.fn() };
    service = new SecretEnforcementService(
      repo as unknown as SecretsRepository,
      adapter as unknown as RouterAdapter,
    );
  });

  it('writes the DB flag and pushes to each affected router', async () => {
    repo.findRouterTargetsByCustomerId.mockResolvedValue([
      {
        secretUsername: 'cust1001',
        host: '10.0.0.1',
        apiPort: 8728,
        routerUser: 'api',
        apiPasswordEncrypted: null,
      },
      {
        secretUsername: 'cust1002',
        host: '10.0.0.2',
        apiPort: 8728,
        routerUser: 'api',
        apiPasswordEncrypted: null,
      },
    ]);
    repo.setDisabledByCustomerId.mockResolvedValue(2);

    const count = await service.applyDisabledForCustomer('cust-1', true);

    expect(count).toBe(2);
    expect(repo.setDisabledByCustomerId).toHaveBeenCalledWith('cust-1', true);
    expect(adapter.setSecretDisabled).toHaveBeenCalledTimes(2);
    expect(adapter.setSecretDisabled).toHaveBeenCalledWith(
      {
        host: '10.0.0.1',
        apiPort: 8728,
        routerUser: 'api',
        apiPasswordEncrypted: null,
        secretUsername: 'cust1001',
      },
      true,
    );
  });

  it('is a no-op push when the customer has no provisioned secret', async () => {
    repo.findRouterTargetsByCustomerId.mockResolvedValue([]);
    repo.setDisabledByCustomerId.mockResolvedValue(0);

    const count = await service.applyDisabledForCustomer('cust-2', true);

    expect(count).toBe(0);
    expect(adapter.setSecretDisabled).not.toHaveBeenCalled();
  });

  it('re-enables (disabled=false) on reactivation', async () => {
    repo.findRouterTargetsByCustomerId.mockResolvedValue([
      {
        secretUsername: 'cust1001',
        host: '10.0.0.1',
        apiPort: 8728,
        routerUser: 'api',
        apiPasswordEncrypted: null,
      },
    ]);
    repo.setDisabledByCustomerId.mockResolvedValue(1);

    await service.applyDisabledForCustomer('cust-1', false);

    expect(adapter.setSecretDisabled).toHaveBeenCalledWith(expect.anything(), false);
  });
});
