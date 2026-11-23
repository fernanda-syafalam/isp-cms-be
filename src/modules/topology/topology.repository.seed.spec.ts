import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/configuration';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import { TopologyRepository } from './topology.repository';

function build(env: { nodeEnv: string; deployEnv?: string }, existing: number) {
  const insert = vi.fn(() => ({
    values: () => ({ onConflictDoNothing: () => Promise.resolve() }),
  }));
  const transaction = vi.fn(async (cb: (tx: { insert: typeof insert }) => Promise<void>) =>
    cb({ insert }),
  );
  const db = {
    select: () => ({ from: () => Promise.resolve([{ value: existing }]) }),
    insert,
    transaction,
  };
  const config = {
    get: (key: string) => (key === 'app.nodeEnv' ? env.nodeEnv : env.deployEnv),
  } as unknown as ConfigService<{ app: AppConfig }, true>;
  const repo = new TopologyRepository({ db } as unknown as DrizzleService, config);
  return { repo, insert, transaction };
}

describe('TopologyRepository.ensureSeeded gate', () => {
  it('does nothing in production on an empty table', async () => {
    const { repo, insert, transaction } = build({ nodeEnv: 'production' }, 0);
    await repo.ensureSeeded();
    expect(transaction).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it.each([
    [{ nodeEnv: 'development' }],
    [{ nodeEnv: 'test' }],
    [{ nodeEnv: 'production', deployEnv: 'demo' }],
  ])('seeds inside one transaction for %j', async (env) => {
    const { repo, insert, transaction } = build(env, 0);
    await repo.ensureSeeded();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalled();
  });

  it('does not seed a non-empty table', async () => {
    const { repo, transaction } = build({ nodeEnv: 'development' }, 5);
    await repo.ensureSeeded();
    expect(transaction).not.toHaveBeenCalled();
  });
});
