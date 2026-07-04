import { type AnyColumn, type SQL, asc, desc } from 'drizzle-orm';

/**
 * Builds a Drizzle `orderBy` expression from a caller-supplied sort key,
 * direction, a whitelist map, and a default fallback expression.
 *
 * Rules:
 * - When `sortKey` is present AND exists in `whitelist`, return `asc` or
 *   `desc` on the mapped column according to `order` (default: `'asc'`).
 * - When `sortKey` is absent, `undefined`, or NOT in the whitelist, return
 *   `defaultOrder` unchanged — never throw.
 *
 * @param sortKey   - The field name the caller wants to sort by (camelCase).
 * @param order     - Direction: `'asc'` | `'desc'`. Defaults to `'asc'`.
 * @param whitelist - Map of allowed camelCase key → Drizzle column.
 * @param defaultOrder - Expression used when sortKey is absent/unknown.
 *
 * @example
 * ```ts
 * buildOrderBy(
 *   filter.sort,
 *   filter.order,
 *   { code: workOrders.code, createdAt: workOrders.createdAt },
 *   desc(workOrders.createdAt),
 * )
 * ```
 */
export function buildOrderBy(
  sortKey: string | undefined,
  order: 'asc' | 'desc' | undefined,
  whitelist: Record<string, AnyColumn>,
  defaultOrder: SQL,
): SQL {
  if (!sortKey) {
    return defaultOrder;
  }

  // Object.hasOwn: '?sort=__proto__' / 'constructor' must fall back to
  // the default order, not resolve a prototype member (P1 review L4).
  const column = Object.hasOwn(whitelist, sortKey) ? whitelist[sortKey] : undefined;
  if (!column) {
    return defaultOrder;
  }

  return order === 'desc' ? desc(column) : asc(column);
}
