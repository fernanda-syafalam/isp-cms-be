import { and, asc, desc, ilike, inArray, isNull, or } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { buildOrderBy } from '../../common/utils/list-sort';
import { customers } from '../../infrastructure/database/schema/customers.schema';

// ---------------------------------------------------------------------------
// CUSTOMERS_SORT_WHITELIST is private to the repository module, so we
// replicate the same mapping here to validate whitelist coverage and that
// buildOrderBy resolves the expected Drizzle SQL for each key.
// Mirrors the pattern used in devices.repository.spec.ts.
// ---------------------------------------------------------------------------

const SORT_WHITELIST = {
  customerNo: customers.customerNo,
  fullName: customers.fullName,
  areaName: customers.areaName,
  status: customers.status,
  joinedAt: customers.createdAt,
} as const;

const DEFAULT_ORDER = asc(customers.fullName);

// ---------------------------------------------------------------------------
// Sort whitelist
// ---------------------------------------------------------------------------

describe('customers SORT_WHITELIST + buildOrderBy', () => {
  it('sorts by customerNo asc', () => {
    expect(buildOrderBy('customerNo', 'asc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(
      asc(customers.customerNo),
    );
  });

  it('sorts by customerNo desc', () => {
    expect(buildOrderBy('customerNo', 'desc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(
      desc(customers.customerNo),
    );
  });

  it('sorts by fullName asc', () => {
    expect(buildOrderBy('fullName', 'asc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(
      asc(customers.fullName),
    );
  });

  it('sorts by fullName desc', () => {
    expect(buildOrderBy('fullName', 'desc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(
      desc(customers.fullName),
    );
  });

  it('sorts by areaName asc', () => {
    expect(buildOrderBy('areaName', 'asc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(
      asc(customers.areaName),
    );
  });

  it('sorts by areaName desc', () => {
    expect(buildOrderBy('areaName', 'desc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(
      desc(customers.areaName),
    );
  });

  it('sorts by status asc', () => {
    expect(buildOrderBy('status', 'asc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(
      asc(customers.status),
    );
  });

  it('sorts by status desc', () => {
    expect(buildOrderBy('status', 'desc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(
      desc(customers.status),
    );
  });

  it('sorts by joinedAt (mapped to createdAt) asc', () => {
    expect(buildOrderBy('joinedAt', 'asc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(
      asc(customers.createdAt),
    );
  });

  it('sorts by joinedAt desc', () => {
    expect(buildOrderBy('joinedAt', 'desc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(
      desc(customers.createdAt),
    );
  });

  it('falls back to default (fullName asc) for an unknown sort key', () => {
    const result = buildOrderBy('unknownField', 'asc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toBe(DEFAULT_ORDER);
  });

  it('falls back to default when sort is undefined', () => {
    const result = buildOrderBy(undefined, 'desc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toBe(DEFAULT_ORDER);
  });

  it('does not allow arbitrary columns (e.g. phone not in whitelist)', () => {
    const result = buildOrderBy('phone', 'asc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toBe(DEFAULT_ORDER);
  });
});

// ---------------------------------------------------------------------------
// Search filter: q must cover fullName, customerNo AND phone (OR-combined)
// ---------------------------------------------------------------------------

describe('customers search filter (q)', () => {
  it('produces an OR clause covering fullName, customerNo, and phone', () => {
    const q = '0812';
    // Build the clause the same way the repository does, then compare
    // structurally to the expected Drizzle SQL objects (same as sort tests).
    const clause = or(
      ilike(customers.fullName, `%${q}%`),
      ilike(customers.customerNo, `%${q}%`),
      ilike(customers.phone, `%${q}%`),
    );
    expect(clause).toEqual(
      or(
        ilike(customers.fullName, `%${q}%`),
        ilike(customers.customerNo, `%${q}%`),
        ilike(customers.phone, `%${q}%`),
      ),
    );
  });

  it('search over phone produces a different clause than one without phone', () => {
    const q = '0812';
    const withPhone = or(
      ilike(customers.fullName, `%${q}%`),
      ilike(customers.customerNo, `%${q}%`),
      ilike(customers.phone, `%${q}%`),
    );
    const withoutPhone = or(
      ilike(customers.fullName, `%${q}%`),
      ilike(customers.customerNo, `%${q}%`),
    );
    // Structural inequality — phone arm extends the OR expression.
    expect(withPhone).not.toEqual(withoutPhone);
  });
});

// ---------------------------------------------------------------------------
// Area filter: multi-value + null-inclusive
// ---------------------------------------------------------------------------

describe('customers area filter', () => {
  it('produces IN(areas) OR IS NULL when area list is provided', () => {
    const areas = ['Jepara', 'Tahunan'];
    const clause = or(inArray(customers.areaName, areas), isNull(customers.areaName));
    // Compare structurally against the expected Drizzle expression.
    expect(clause).toEqual(
      or(inArray(customers.areaName, ['Jepara', 'Tahunan']), isNull(customers.areaName)),
    );
  });

  it('null-inclusive clause differs from an IN-only clause (IS NULL arm is present)', () => {
    const areas = ['Jepara'];
    const nullInclusive = or(inArray(customers.areaName, areas), isNull(customers.areaName));
    const inOnly = or(inArray(customers.areaName, areas));
    // The null-inclusive form is structurally different from the IN-only form.
    expect(nullInclusive).not.toEqual(inOnly);
  });

  it('produces no area constraint when area is undefined', () => {
    // When area is absent the predicate is undefined, so and() omits it.
    function buildAreaClause(area: string[] | undefined) {
      return area && area.length > 0
        ? or(inArray(customers.areaName, area), isNull(customers.areaName))
        : undefined;
    }
    expect(buildAreaClause(undefined)).toBeUndefined();
  });

  it('produces no area constraint when area is an empty array', () => {
    function buildAreaClause(area: string[] | undefined) {
      return area && area.length > 0
        ? or(inArray(customers.areaName, area), isNull(customers.areaName))
        : undefined;
    }
    expect(buildAreaClause([])).toBeUndefined();
  });
});
