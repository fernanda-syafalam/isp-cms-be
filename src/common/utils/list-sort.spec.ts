import { type AnyColumn, type SQL, asc, desc } from 'drizzle-orm';
import { timestamp, varchar } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { buildOrderBy } from './list-sort';

// ---------------------------------------------------------------------------
// Minimal Drizzle column stubs — we only need objects that satisfy AnyColumn
// so we can test identity equality on the returned SQL expressions.
// ---------------------------------------------------------------------------

// Build a minimal table-column pair that Drizzle's asc/desc can accept.
// Using real Drizzle constructors avoids `as unknown as AnyColumn` casts.
import { pgTable } from 'drizzle-orm/pg-core';

const testTable = pgTable('_test', {
  code: varchar('code', { length: 32 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

const colCode = testTable.code as unknown as AnyColumn;
const colCreatedAt = testTable.createdAt as unknown as AnyColumn;

const whitelist: Record<string, AnyColumn> = {
  code: colCode,
  createdAt: colCreatedAt,
};

// The default used in all fall-through cases.
const DEFAULT: SQL = desc(colCreatedAt);

describe('buildOrderBy', () => {
  it('returns asc(column) for a valid key when order is "asc"', () => {
    const result = buildOrderBy('code', 'asc', whitelist, DEFAULT);
    // The SQL fragment must equal what asc() produces for the same column.
    expect(result).toEqual(asc(colCode));
  });

  it('returns desc(column) for a valid key when order is "desc"', () => {
    const result = buildOrderBy('code', 'desc', whitelist, DEFAULT);
    expect(result).toEqual(desc(colCode));
  });

  it('defaults to asc when order is undefined and key is valid', () => {
    const result = buildOrderBy('createdAt', undefined, whitelist, DEFAULT);
    expect(result).toEqual(asc(colCreatedAt));
  });

  it('returns the default when sortKey is absent (undefined)', () => {
    const result = buildOrderBy(undefined, 'asc', whitelist, DEFAULT);
    expect(result).toBe(DEFAULT);
  });

  it('returns the default when sortKey is not in the whitelist', () => {
    const result = buildOrderBy('unknownField', 'asc', whitelist, DEFAULT);
    expect(result).toBe(DEFAULT);
  });

  it('returns the default for another unknown key regardless of order', () => {
    const result = buildOrderBy('status', 'desc', whitelist, DEFAULT);
    expect(result).toBe(DEFAULT);
  });
});
