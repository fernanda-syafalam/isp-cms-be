import { asc, desc } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { buildOrderBy } from '../../common/utils/list-sort';
import { tickets } from '../../infrastructure/database/schema/tickets.schema';

// ---------------------------------------------------------------------------
// SORT_WHITELIST is not exported from the repository (intentionally private),
// so we replicate the same mapping here to validate that the columns resolve
// correctly and that buildOrderBy applies the expected direction.
// ---------------------------------------------------------------------------

const SORT_WHITELIST = {
  code: tickets.code,
  status: tickets.status,
  priority: tickets.priority,
  slaDueAt: tickets.slaDueAt,
  createdAt: tickets.createdAt,
} as const;

const DEFAULT_ORDER = desc(tickets.createdAt);

describe('tickets SORT_WHITELIST + buildOrderBy', () => {
  it('sorts by code asc when sort=code order=asc', () => {
    const result = buildOrderBy('code', 'asc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toEqual(asc(tickets.code));
  });

  it('sorts by code desc when sort=code order=desc', () => {
    const result = buildOrderBy('code', 'desc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toEqual(desc(tickets.code));
  });

  it('sorts by status asc', () => {
    const result = buildOrderBy('status', 'asc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toEqual(asc(tickets.status));
  });

  it('sorts by priority desc', () => {
    const result = buildOrderBy('priority', 'desc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toEqual(desc(tickets.priority));
  });

  it('sorts by slaDueAt asc', () => {
    const result = buildOrderBy('slaDueAt', 'asc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toEqual(asc(tickets.slaDueAt));
  });

  it('sorts by createdAt desc', () => {
    const result = buildOrderBy('createdAt', 'desc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toEqual(desc(tickets.createdAt));
  });

  it('falls back to default (createdAt desc) for an unknown sort key', () => {
    const result = buildOrderBy('unknownField', 'asc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toBe(DEFAULT_ORDER);
  });

  it('falls back to default when sort is undefined', () => {
    const result = buildOrderBy(undefined, 'desc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toBe(DEFAULT_ORDER);
  });

  it('falls back to default for subject (not in whitelist)', () => {
    const result = buildOrderBy('subject', 'asc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toBe(DEFAULT_ORDER);
  });
});
