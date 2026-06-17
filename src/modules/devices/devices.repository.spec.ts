import { asc, desc } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { buildOrderBy } from '../../common/utils/list-sort';
import { devices } from '../../infrastructure/database/schema/devices.schema';

// ---------------------------------------------------------------------------
// SORT_WHITELIST is not exported from the repository (intentionally private),
// so we replicate the same mapping here to validate that the columns resolve
// correctly and that buildOrderBy applies the expected direction.
// This mirrors how list-sort.spec.ts validates the utility with real columns.
// ---------------------------------------------------------------------------

const SORT_WHITELIST = {
  name: devices.name,
  status: devices.status,
  rxPower: devices.rxPower,
  uptimeHours: devices.uptimeHours,
  lastSeenAt: devices.lastSeenAt,
} as const;

const DEFAULT_ORDER = asc(devices.name);

describe('devices SORT_WHITELIST + buildOrderBy', () => {
  it('sorts by name asc when sort=name order=asc', () => {
    const result = buildOrderBy('name', 'asc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toEqual(asc(devices.name));
  });

  it('sorts by name desc when sort=name order=desc', () => {
    const result = buildOrderBy('name', 'desc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toEqual(desc(devices.name));
  });

  it('sorts by status asc', () => {
    const result = buildOrderBy('status', 'asc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toEqual(asc(devices.status));
  });

  it('sorts by rxPower desc', () => {
    const result = buildOrderBy('rxPower', 'desc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toEqual(desc(devices.rxPower));
  });

  it('sorts by uptimeHours desc', () => {
    const result = buildOrderBy('uptimeHours', 'desc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toEqual(desc(devices.uptimeHours));
  });

  it('sorts by lastSeenAt asc', () => {
    const result = buildOrderBy('lastSeenAt', 'asc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toEqual(asc(devices.lastSeenAt));
  });

  it('falls back to default (name asc) for an unknown sort key', () => {
    const result = buildOrderBy('unknownField', 'asc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toBe(DEFAULT_ORDER);
  });

  it('falls back to default when sort is undefined', () => {
    const result = buildOrderBy(undefined, 'desc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toBe(DEFAULT_ORDER);
  });

  it('falls back to default for ipAddress (not in whitelist)', () => {
    const result = buildOrderBy('ipAddress', 'asc', SORT_WHITELIST, DEFAULT_ORDER);
    expect(result).toBe(DEFAULT_ORDER);
  });
});
