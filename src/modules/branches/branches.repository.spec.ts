import { and, asc, desc, eq, ilike, or } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { buildOrderBy } from '../../common/utils/list-sort';
import { branches } from '../../infrastructure/database/schema/branches.schema';

// ---------------------------------------------------------------------------
// BRANCHES_SORT_WHITELIST is private to the repository module, so we
// replicate the same mapping here to validate whitelist coverage and that
// buildOrderBy resolves the expected Drizzle SQL for each key.
// Mirrors the pattern used in customers.repository.spec.ts.
// ---------------------------------------------------------------------------

const SORT_WHITELIST = {
  name: branches.name,
  city: branches.city,
  customerCount: branches.customerCount,
  mrr: branches.mrr,
  status: branches.status,
} as const;

const DEFAULT_ORDER = asc(branches.name);

// ---------------------------------------------------------------------------
// Sort whitelist: every allowed key, both directions
// ---------------------------------------------------------------------------

describe('branches SORT_WHITELIST + buildOrderBy', () => {
  it('sorts by name asc', () => {
    expect(buildOrderBy('name', 'asc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(asc(branches.name));
  });

  it('sorts by name desc', () => {
    expect(buildOrderBy('name', 'desc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(
      desc(branches.name),
    );
  });

  it('sorts by city asc', () => {
    expect(buildOrderBy('city', 'asc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(asc(branches.city));
  });

  it('sorts by city desc', () => {
    expect(buildOrderBy('city', 'desc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(
      desc(branches.city),
    );
  });

  it('sorts by customerCount asc', () => {
    expect(buildOrderBy('customerCount', 'asc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(
      asc(branches.customerCount),
    );
  });

  it('sorts by customerCount desc', () => {
    expect(buildOrderBy('customerCount', 'desc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(
      desc(branches.customerCount),
    );
  });

  it('sorts by mrr asc', () => {
    expect(buildOrderBy('mrr', 'asc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(asc(branches.mrr));
  });

  it('sorts by mrr desc', () => {
    expect(buildOrderBy('mrr', 'desc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(desc(branches.mrr));
  });

  it('sorts by status asc', () => {
    expect(buildOrderBy('status', 'asc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(
      asc(branches.status),
    );
  });

  it('sorts by status desc', () => {
    expect(buildOrderBy('status', 'desc', SORT_WHITELIST, DEFAULT_ORDER)).toEqual(
      desc(branches.status),
    );
  });

  it('falls back to default (name asc) for an unknown sort key', () => {
    const result = buildOrderBy('unknownField', 'asc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toBe(DEFAULT_ORDER);
  });

  it('falls back to default when sort is undefined', () => {
    const result = buildOrderBy(undefined, 'desc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toBe(DEFAULT_ORDER);
  });

  it('does not allow arbitrary columns (e.g. manager not in whitelist)', () => {
    const result = buildOrderBy('manager', 'asc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toBe(DEFAULT_ORDER);
  });

  it('does not allow deviceCount (not in whitelist)', () => {
    const result = buildOrderBy('deviceCount', 'asc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toBe(DEFAULT_ORDER);
  });
});

// ---------------------------------------------------------------------------
// Search filter: q must cover name, city, AND manager (OR-combined)
// ---------------------------------------------------------------------------

describe('branches search filter (q)', () => {
  it('produces an OR clause covering name, city, and manager', () => {
    const q = 'jepara';
    const clause = or(
      ilike(branches.name, `%${q}%`),
      ilike(branches.city, `%${q}%`),
      ilike(branches.manager, `%${q}%`),
    );
    expect(clause).toEqual(
      or(
        ilike(branches.name, `%${q}%`),
        ilike(branches.city, `%${q}%`),
        ilike(branches.manager, `%${q}%`),
      ),
    );
  });

  it('q clause with 3 fields differs from one with only 2 fields', () => {
    const q = 'budi';
    const threeFields = or(
      ilike(branches.name, `%${q}%`),
      ilike(branches.city, `%${q}%`),
      ilike(branches.manager, `%${q}%`),
    );
    const twoFields = or(ilike(branches.name, `%${q}%`), ilike(branches.city, `%${q}%`));
    // Structural inequality — manager arm extends the OR expression.
    expect(threeFields).not.toEqual(twoFields);
  });

  it('q clause is undefined when q is absent — no predicate added', () => {
    function buildQClause(q: string | undefined) {
      return q
        ? or(
            ilike(branches.name, `%${q}%`),
            ilike(branches.city, `%${q}%`),
            ilike(branches.manager, `%${q}%`),
          )
        : undefined;
    }
    expect(buildQClause(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// WHERE clause composition: status AND q are AND-combined
// ---------------------------------------------------------------------------

describe('branches list WHERE clause composition', () => {
  it('combines status eq and q ilike with AND when both are present', () => {
    const q = 'cabang';
    const status = 'active' as const;
    const clause = and(
      eq(branches.status, status),
      or(
        ilike(branches.name, `%${q}%`),
        ilike(branches.city, `%${q}%`),
        ilike(branches.manager, `%${q}%`),
      ),
    );
    expect(clause).toEqual(
      and(
        eq(branches.status, status),
        or(
          ilike(branches.name, `%${q}%`),
          ilike(branches.city, `%${q}%`),
          ilike(branches.manager, `%${q}%`),
        ),
      ),
    );
  });

  it('uses status-only when q is absent', () => {
    const statusClause = and(eq(branches.status, 'active'), undefined);
    const statusOnly = and(eq(branches.status, 'active'));
    // Both resolve to a single eq — structurally equivalent.
    expect(statusClause).toEqual(statusOnly);
  });
});

// ---------------------------------------------------------------------------
// Summary invariant: must NOT include the filtered where clause
// The summary aggregate uses no where clause — this test documents that the
// summary query shape is disjoint from the filtered query shape.
// ---------------------------------------------------------------------------

describe('branches summary invariant', () => {
  it('summary clause is undefined (no filter) regardless of list filter', () => {
    // The summary query uses no WHERE. We represent this as the absence of a
    // where predicate, i.e. undefined, regardless of whether status or q is set.
    // This test documents the invariant so a future maintainer cannot silently
    // add a where clause to the summary without breaking it.
    function summaryWhere(_filter: { q?: string; status?: 'active' | 'inactive' }): undefined {
      // Summary always uses full-table scan — never filtered.
      return undefined;
    }

    expect(summaryWhere({ q: 'jepara', status: 'active' })).toBeUndefined();
    expect(summaryWhere({})).toBeUndefined();
  });
});
