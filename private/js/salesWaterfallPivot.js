// private/js/salesWaterfallPivot.js
//
// Client-side pivot builder for the Sales "Schedule Agreement Waterfall"
// tool (rebuild of N:\Config\Office\Templates\AT_46c\sd_waterfall.xltm — see
// that plan's Context section for the reverse-engineering trail). The
// backend (routes/salessap.js -> SapServer's SalesController) returns a flat
// array of rows, one per (release, schedule line) — this module groups them
// into the pivot shape the source tool's "Pivot" sheet showed: one row per
// past pull (or the live/current schedule), one column per target schedule
// week, cell = that pull's requested quantity for that week.
//
// A plain ES module (not a global script like sales.js) so it can be
// imported directly by Jest as well as loaded via <script type="module">.

// rows: ScheduleWaterfallRow[] as returned by GET /api/sales/schedule-waterfall
//   (camelCase JSON — shipToParty, material, materialDescription, idocNumber,
//   idocWeek, idocCreationDate, scheduleWeek, orderQty, cumulativeRelease,
//   isCurrent, ...).
// options.cumulative: false (default) shows raw OrderQty per cell — matches
//   the source tool's default pivot state; true shows the running
//   cumulative total instead (sd_waterfall.xltm's pt_cum_on_off toggle).
//
// Returns { weeks: number[], rows: PivotRow[] } where each PivotRow is
// { shipToParty, material, materialDescription, idocWeek, idocCreationDate,
//   idocNumber, isCurrent, cells: Map<week, value> }.
export function buildWaterfallPivot(rows, options = {}) {
  const cumulative = !!options.cumulative;
  const weekSet = new Set();
  const groups = new Map();

  for (const row of rows || []) {
    if (!row || !row.scheduleWeek) continue;
    weekSet.add(row.scheduleWeek);

    const releaseKey = row.isCurrent ? 'current' : row.idocNumber;
    const key = [row.shipToParty, row.material, row.idocWeek, row.idocCreationDate, releaseKey].join('|');

    let group = groups.get(key);
    if (!group) {
      group = {
        shipToParty: row.shipToParty,
        material: row.material,
        materialDescription: row.materialDescription,
        idocWeek: row.idocWeek,
        idocCreationDate: row.idocCreationDate,
        idocNumber: row.isCurrent ? 'Current' : row.idocNumber,
        isCurrent: !!row.isCurrent,
        cells: new Map(),
      };
      groups.set(key, group);
    }

    const value = cumulative ? (row.cumulativeRelease || 0) : (row.orderQty || 0);
    const existing = group.cells.get(row.scheduleWeek);
    // Raw mode sums (matches the source pivot's SUM(Order qty) data field —
    // more than one schedule line can legitimately land on the same week).
    // Cumulative mode instead keeps the running total's high-water mark for
    // that week, since summing two already-cumulative values would double count.
    group.cells.set(
      row.scheduleWeek,
      existing === undefined ? value : (cumulative ? Math.max(existing, value) : existing + value)
    );
  }

  const weeks = Array.from(weekSet).sort((a, b) => a - b);
  const pivotRows = Array.from(groups.values()).sort((a, b) =>
    String(a.shipToParty).localeCompare(String(b.shipToParty)) ||
    String(a.material).localeCompare(String(b.material)) ||
    (a.idocWeek - b.idocWeek) ||
    String(a.idocCreationDate || '').localeCompare(String(b.idocCreationDate || '')) ||
    String(a.idocNumber).localeCompare(String(b.idocNumber))
  );

  return { weeks, rows: pivotRows };
}
