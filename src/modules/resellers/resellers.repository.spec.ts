import { describe, expect, it, vi } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import { resellers } from '../../infrastructure/database/schema/resellers.schema';
import { ResellersRepository } from './resellers.repository';

type Call = string;

function buildFakeDb(calls: Call[], tables: unknown[]) {
  const row = { id: 'r1', balance: 100_000 };
  const selectBuilder = {
    from: vi.fn((table: unknown) => {
      tables.push(table);
      return selectBuilder;
    }),
    where: vi.fn(() => selectBuilder),
    for: vi.fn((mode: string) => {
      calls.push(`for:${mode}`);
      return selectBuilder;
    }),
    limit: vi.fn(() => {
      calls.push('limit');
      return Promise.resolve([row]);
    }),
  };
  const writeBuilder = {
    values: vi.fn(() => Promise.resolve([])),
    set: vi.fn(() => writeBuilder),
    where: vi.fn(() => writeBuilder),
    returning: vi.fn(() => Promise.resolve([{ ...row, balance: 30_000 }])),
  };
  const tx = {
    select: vi.fn(() => selectBuilder),
    insert: vi.fn(() => writeBuilder),
    update: vi.fn(() => writeBuilder),
  };
  const db = { transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)) };
  return db;
}

describe('ResellersRepository.addLedgerEntry', () => {
  it('locks the reseller row (FOR UPDATE) before reading the balance', async () => {
    const calls: Call[] = [];
    const tables: unknown[] = [];
    const repo = new ResellersRepository({
      db: buildFakeDb(calls, tables),
    } as unknown as DrizzleService);

    await repo.addLedgerEntry('r1', { type: 'deduction', amount: 70_000, note: 'Potong' });

    expect(tables).toEqual([resellers]);
    expect(calls).toEqual(['for:update', 'limit']);
  });
});
