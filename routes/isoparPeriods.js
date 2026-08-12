// Pure date math for the Isopar Tied Oil HMRC declaration schedule — a fixed
// 3-month cycle anchored at ISOPAR_ANCHOR_PERIOD_START (2026-08-01), NOT
// calendar quarters (Jan/Apr/Jul/Oct). Period 0 = 2026-08-01..2026-10-31,
// period 1 = 2026-11-01..2027-01-31, period 2 = 2027-02-01..2027-04-30
// (naturally handles Feb 28/29 via UTC month arithmetic), period 3 =
// 2027-05-01..2027-07-31, then it repeats. No DB access — hand-verifiable
// in isolation.

import { ISOPAR_ANCHOR_PERIOD_START } from './isoparConstants.js';

const ANCHOR_YEAR = ISOPAR_ANCHOR_PERIOD_START.getUTCFullYear();
const ANCHOR_MONTH = ISOPAR_ANCHOR_PERIOD_START.getUTCMonth(); // 7 (August)

// { start, end } for the given zero-based period index — end is the last
// calendar day of the period (inclusive), at UTC midnight.
export function isoparPeriodBounds(periodIndex) {
  const start = new Date(Date.UTC(ANCHOR_YEAR, ANCHOR_MONTH + periodIndex * 3, 1));
  const nextStart = new Date(Date.UTC(ANCHOR_YEAR, ANCHOR_MONTH + (periodIndex + 1) * 3, 1));
  const end = new Date(nextStart.getTime() - 86400000); // one day before the next period starts
  return { start, end };
}

// Which period index a given date falls within. Floors on whole months
// since the anchor, divided into groups of 3 — safe because every period
// starts exactly on the 1st of a month and spans exactly 3 calendar months,
// so bucketing by month (ignoring day-of-month) always lands correctly.
export function isoparPeriodIndexForDate(date) {
  const monthsSinceAnchor = (date.getUTCFullYear() - ANCHOR_YEAR) * 12 + (date.getUTCMonth() - ANCHOR_MONTH);
  return Math.floor(monthsSinceAnchor / 3);
}

export function isoparPeriodContaining(date) {
  return isoparPeriodBounds(isoparPeriodIndexForDate(date));
}

// Every period whose end date is strictly before `date`, oldest first —
// used to find which declarations are outstanding (see
// listIsoparOutstandingPeriods in performancesql.js). Walks forward from
// period 0 rather than back from `date`'s own period, since a period is
// only "ended" once its end date has passed, and there's no way to jump
// straight to "how many periods have fully elapsed" without walking (the
// anchor is fixed, so this list is short in practice — a handful of periods
// per year since go-live).
export function isoparPeriodsEndedBefore(date) {
  const periods = [];
  let index = 0;
  while (true) {
    const { start, end } = isoparPeriodBounds(index);
    // `end` is stored as UTC midnight of the last calendar day, but that whole day (through
    // 23:59:59) still belongs to the period — so "has this period fully ended" means `date` has
    // reached the start of the FOLLOWING day, not merely passed the `end` instant itself.
    const periodFullyEndedAt = new Date(end.getTime() + 86400000);
    if (periodFullyEndedAt > date) break;
    periods.push({ index, start, end });
    index += 1;
  }
  return periods;
}
