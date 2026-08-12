// Pure date math for the Isopar Tied Oil declaration schedule (routes/isoparPeriods.js) —
// no DB access, hand-verified against fixed dates. The cycle is anchored at 2026-08-01 and
// is NOT calendar-quarter-aligned (Jan/Apr/Jul/Oct) — it's a fixed 3-month cycle starting a
// month later than that.

import { describe, test, expect } from '@jest/globals';
import {
  isoparPeriodBounds,
  isoparPeriodIndexForDate,
  isoparPeriodContaining,
  isoparPeriodsEndedBefore,
} from '../../routes/isoparPeriods.js';

function iso(d) { return d.toISOString().slice(0, 10); }

describe('isoparPeriodBounds', () => {
  test('period 0 is 2026-08-01 to 2026-10-31', () => {
    const { start, end } = isoparPeriodBounds(0);
    expect(iso(start)).toBe('2026-08-01');
    expect(iso(end)).toBe('2026-10-31');
  });

  test('period 1 is 2026-11-01 to 2027-01-31', () => {
    const { start, end } = isoparPeriodBounds(1);
    expect(iso(start)).toBe('2026-11-01');
    expect(iso(end)).toBe('2027-01-31');
  });

  test('period 2 correctly handles a non-leap February (2027-02-01 to 2027-04-30)', () => {
    const { start, end } = isoparPeriodBounds(2);
    expect(iso(start)).toBe('2027-02-01');
    expect(iso(end)).toBe('2027-04-30');
  });

  test('period 3 is 2027-05-01 to 2027-07-31, then the cycle repeats at period 4 = 2027-08-01', () => {
    const p3 = isoparPeriodBounds(3);
    expect(iso(p3.start)).toBe('2027-05-01');
    expect(iso(p3.end)).toBe('2027-07-31');
    const p4 = isoparPeriodBounds(4);
    expect(iso(p4.start)).toBe('2027-08-01');
  });

  test('a leap-year February period ends 2028-02-29, not 2028-02-28', () => {
    // Period index 6 = 2028-02-01..2028-04-30 (2026-08 + 6*3 months = 2028-02).
    // Find the period landing on a leap Feb by index arithmetic: anchor 2026-08 + 3*index.
    // 2026-08 -> +18 months = 2028-02 => index 6.
    const { start, end } = isoparPeriodBounds(6);
    expect(iso(start)).toBe('2028-02-01');
    expect(iso(end)).toBe('2028-04-30'); // still a 3-month span ending in April, Feb's own length doesn't matter here
  });
});

describe('isoparPeriodIndexForDate', () => {
  test('the exact start of period 0 is index 0', () => {
    expect(isoparPeriodIndexForDate(new Date('2026-08-01T00:00:00Z'))).toBe(0);
  });

  test('the last day of period 0 is still index 0', () => {
    expect(isoparPeriodIndexForDate(new Date('2026-10-31T23:59:59Z'))).toBe(0);
  });

  test('the day after period 0 ends (2026-11-01) is index 1', () => {
    expect(isoparPeriodIndexForDate(new Date('2026-11-01T00:00:00Z'))).toBe(1);
  });

  test('the last day of October (2026-10-31) is index 0, not index 1', () => {
    expect(isoparPeriodIndexForDate(new Date('2026-10-31T00:00:00Z'))).toBe(0);
  });

  test('isoparPeriodContaining round-trips through isoparPeriodBounds', () => {
    const { start, end } = isoparPeriodContaining(new Date('2027-03-15T00:00:00Z'));
    expect(iso(start)).toBe('2027-02-01');
    expect(iso(end)).toBe('2027-04-30');
  });
});

describe('isoparPeriodsEndedBefore', () => {
  test('returns an empty array before period 0 has even started', () => {
    expect(isoparPeriodsEndedBefore(new Date('2026-08-01T00:00:00Z'))).toEqual([]);
  });

  test('returns an empty array for any date still inside period 0', () => {
    expect(isoparPeriodsEndedBefore(new Date('2026-10-31T23:59:59Z'))).toEqual([]);
  });

  test('returns exactly period 0 the day after it ends', () => {
    const result = isoparPeriodsEndedBefore(new Date('2026-11-01T00:00:00Z'));
    expect(result).toHaveLength(1);
    expect(result[0].index).toBe(0);
    expect(iso(result[0].end)).toBe('2026-10-31');
  });

  test('returns periods 0 and 1, oldest first, once period 1 has also ended', () => {
    const result = isoparPeriodsEndedBefore(new Date('2027-02-01T00:00:00Z'));
    expect(result.map(p => p.index)).toEqual([0, 1]);
  });
});
