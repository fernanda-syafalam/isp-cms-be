// TIME-1: date-only business math (aging buckets, grace periods, dunning
// windows) must land on the WIB (Asia/Jakarta) calendar day, not the raw
// UTC calendar day or a `getTime()` instant diff — see wibDateString's and
// daysBetweenDates' doc comments below.
//
// Asia/Jakarta has a fixed UTC+7 offset with no daylight saving, so a
// constant offset is correct year-round — no IANA tz database lookup
// needed. That also makes these helpers deliberately independent of the
// process's own `TZ` env var: they stay correct even if a container /
// local dev / CI run forgets to set `TZ=Asia/Jakarta` (defense in depth
// alongside the Dockerfile/compose fix for that layer).

/**
 * The single named source of truth for "which timezone is the business
 * clock" (TIME-1). Reused wherever a component needs to say so explicitly
 * instead of implicitly trusting the ambient server clock — BullMQ's cron
 * `tz` option (`scheduler.constants.ts`) and the Postgres session
 * timezone (`drizzle.service.ts`) both import this rather than repeating
 * the string literal.
 */
export const WIB_TIMEZONE = 'Asia/Jakarta';

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/**
 * The calendar date (YYYY-MM-DD) in Asia/Jakarta for a given instant.
 * Use this instead of `instant.toISOString().slice(0, 10)` (UTC day) or
 * `instant.getFullYear()/getMonth()/getDate()` (whatever the process TZ
 * happens to be) anywhere Node-side code needs "today" for a WIB-facing
 * business rule.
 */
export function wibDateString(instant: Date): string {
  const shifted = new Date(instant.getTime() + WIB_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Whole days between two YYYY-MM-DD calendar dates (positive when `to` is
 * after `from`, negative when `to` is before `from`). Both sides are
 * parsed as UTC midnight so the subtraction is pure calendar-day
 * arithmetic — it never gets re-interpreted through a local timezone, so
 * it can't drift by a day depending on process TZ or on exactly what time
 * of day `to`/`from` was computed at.
 *
 * This is the fix for the TIME-1 off-by-one: the old code diffed a
 * UTC-midnight-parsed due date against the *exact instant* `now.getTime()`
 * — comparing an instant to a calendar day is TZ-sensitive right around
 * WIB midnight (a due date can already read "1 day overdue" in WIB while
 * the UTC clock is still on the due date itself, because WIB is UTC+7).
 * Reducing both sides to calendar dates first removes that sensitivity.
 */
export function daysBetweenDates(fromDate: string, toDate: string): number {
  const from = Date.parse(`${fromDate}T00:00:00.000Z`);
  const to = Date.parse(`${toDate}T00:00:00.000Z`);
  return Math.round((to - from) / DAY_MS);
}
