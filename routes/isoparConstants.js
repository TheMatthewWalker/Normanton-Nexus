// Shared constants for the Isopar Tied Oil feature (Material 10010) — kept in
// their own tiny module so routes/performance.js and routes/performancesql.js
// can both reference the same values without importing from each other in
// the wrong direction.

export const ISOPAR_MATERIAL = '10010';

// First HMRC Tied Oil declaration period starts here (2026-08-01) — see
// routes/isoparPeriods.js for the fixed 3-month cycle anchored on this date.
export const ISOPAR_ANCHOR_PERIOD_START = new Date(Date.UTC(2026, 7, 1));
