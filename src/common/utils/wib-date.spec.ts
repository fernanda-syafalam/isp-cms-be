import { describe, expect, it } from 'vitest';
import { daysBetweenDates, wibDateString } from './wib-date';

describe('wibDateString', () => {
  it('reads the WIB calendar day (WIB is UTC+7, so it rolls over 7 hours before the UTC day does)', () => {
    // 17:00 UTC = 00:00 WIB (UTC+7): the WIB day has already rolled over to
    // the 24th while the UTC day is still the 23rd.
    expect(wibDateString(new Date('2026-07-23T17:00:00.000Z'))).toBe('2026-07-24');
    // One millisecond earlier, WIB is still on the 23rd.
    expect(wibDateString(new Date('2026-07-23T16:59:59.999Z'))).toBe('2026-07-23');
  });

  it('matches the UTC calendar day away from the WIB-midnight boundary', () => {
    expect(wibDateString(new Date('2026-07-23T03:00:00.000Z'))).toBe('2026-07-23');
  });
});

describe('daysBetweenDates', () => {
  it('is 0 for the same calendar date', () => {
    expect(daysBetweenDates('2026-07-23', '2026-07-23')).toBe(0);
  });

  it('is positive when `to` is after `from`, negative when before', () => {
    expect(daysBetweenDates('2026-07-01', '2026-07-15')).toBe(14);
    expect(daysBetweenDates('2026-07-15', '2026-07-01')).toBe(-14);
  });

  it('crosses a month boundary correctly', () => {
    expect(daysBetweenDates('2026-06-25', '2026-07-05')).toBe(10);
  });
});

describe('TIME-1 off-by-one regression: wibDateString + daysBetweenDates composed, across a WIB-midnight boundary', () => {
  // This is the exact bug: an invoice due 2026-07-23 is compared against
  // "now" = 2026-07-23T18:00:00Z. That instant is *already* 2026-07-24
  // 01:00 WIB — one full day past the due date on the WIB calendar the
  // business runs on — even though the UTC clock still reads the due date.
  const dueDate = '2026-07-23';
  const nowJustAfterWibMidnight = new Date('2026-07-23T18:00:00.000Z'); // 01:00 WIB, 24th

  it('the old getTime()-diff approach would have floored to 0 days (wrongly "not yet due")', () => {
    const buggyDays = Math.floor(
      (nowJustAfterWibMidnight.getTime() - new Date(dueDate).getTime()) / 86_400_000,
    );
    expect(buggyDays).toBe(0);
  });

  it('the WIB-calendar-day approach correctly reports 1 day overdue', () => {
    const today = wibDateString(nowJustAfterWibMidnight);
    expect(today).toBe('2026-07-24');
    expect(daysBetweenDates(dueDate, today)).toBe(1);
  });

  it('one millisecond before WIB midnight, the same due date correctly reports 0 days (not yet overdue)', () => {
    const justBeforeWibMidnight = new Date('2026-07-23T16:59:59.999Z'); // 23:59:59.999 WIB, 23rd
    const today = wibDateString(justBeforeWibMidnight);
    expect(today).toBe('2026-07-23');
    expect(daysBetweenDates(dueDate, today)).toBe(0);
  });
});
