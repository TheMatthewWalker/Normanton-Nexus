// routes/stockcountsql.js
//
// DB layer for the Stock Count feature (Weekly PTFE Cycle Count, Full
// Warehouse Raw Material Scan, Production Count, Finished Goods Count). See
// migrations/nexus_operations/20260814120000_stock_count.cjs for the full
// schema + the approved plan for the workflow writeup.
//
// SAP calls (stock lookup + goods movement/transfer order posting) go
// straight to SapServer from routes/stockcount.js, same per-file boilerplate
// pattern as staging.js/productionnexus.js/quality.js — this module is pure
// DB access, no axios here.

import sql from 'mssql';
import { getNexusOperationsPool } from '../config.js';

const getPool = getNexusOperationsPool;

const DOCUMENT_COLUMNS = `
  CountId, CountType, StorageLocation, Status, WeekStartDate,
  CreatedBy, CreatedByUserId, CreatedAtUtc,
  SubmittedBy, SubmittedAtUtc,
  ApprovedBy, ApprovedAtUtc,
  RejectedBy, RejectedAtUtc, RejectionReason,
  ReopenedBy, ReopenedAtUtc,
  PostedByUserId, PostedAtUtc,
  Notes
`;

// TicketNumber is per-LINE, not per-document (RAW_MATERIAL/PRODUCTION only)
// — every physical lot counted on paper gets its own ticket + label.
const LINE_COLUMNS = `
  LineId, CountId, Material, MaterialText, Uom, NamedLocation, StorageType, Bin, TicketNumber,
  CountedQty, SapQty, VarianceQty, UnitPrice, VarianceValue,
  IsInvalidMaterial, IsBatchManaged,
  BinCompletedBy, BinCompletedAtUtc,
  EnteredBy, EnteredAtUtc, UpdatedAtUtc
`;

// Active statuses that engage the transfer-request block (see
// lib/stockCountGuard.js) — a count isn't safe from invalidation by a stray
// transfer until its adjustments have actually posted (or, for
// FINISHED_GOODS, until the scan session is explicitly closed).
export const ACTIVE_STATUSES = ['Open', 'PendingApproval', 'Approved'];

// ── Material validation ──────────────────────────────────────────────────────
//
// Same read-only source as staging.js's searchMaterials — log.TurnsValClassSnapshot,
// the daily-synced material master snapshot (no live SAP call, no FK — see the
// migration's header comment for why). Ungated, matches Staging Post's own
// material search.

export async function searchMaterialForCount(material) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('material', sql.NVarChar(18), material)
    .query(`
      SELECT TOP 1 Material AS material, MaterialText AS materialText, Uom AS uom, UnitPrice AS unitPrice
      FROM log.TurnsValClassSnapshot
      WHERE Material = @material
    `);
  return recordset[0] || null;
}

export async function searchMaterialsForCount(search) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('search', sql.VarChar(42), `%${search}%`)
    .query(`
      SELECT TOP 30 Material AS material, MaterialText AS materialText, Uom AS uom, UnitPrice AS unitPrice
      FROM log.TurnsValClassSnapshot
      WHERE Material LIKE @search
      ORDER BY Material
    `);
  return recordset;
}

// Fuzzy-match suggestions for the Invalid Materials view — "1-2 character
// difference" per the approved plan. No SQL Server-side fuzzy matching for
// alphanumeric part numbers here; pulls the (small, few-thousand-row)
// distinct material list once and Levenshtein-diffs it in Node. Capped to
// materials of a similar length to the input (±2 chars) before scoring, so
// this stays cheap even as the snapshot grows.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

export async function fuzzyMatchMaterial(material, { maxDistance = 2, limit = 5 } = {}) {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT Material AS material, MaterialText AS materialText, Uom AS uom
    FROM log.TurnsValClassSnapshot
  `);
  const target = String(material || '').toUpperCase();
  return recordset
    .map((row) => ({ ...row, distance: levenshtein(target, String(row.material).toUpperCase()) }))
    .filter((row) => row.distance > 0 && row.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

// ── Count documents — reads ──────────────────────────────────────────────────

export async function getCountDocument(countId) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('countId', sql.Int, countId)
    .query(`SELECT ${DOCUMENT_COLUMNS} FROM log.StockCountDocument WHERE CountId = @countId`);
  return recordset[0] || null;
}

export async function listCountDocuments({ countType, status } = {}) {
  const pool = await getPool();
  const request = pool.request();
  const where = [];
  if (countType) { where.push('CountType = @countType'); request.input('countType', sql.NVarChar(20), countType); }
  if (status)    { where.push('Status = @status');       request.input('status',    sql.NVarChar(20), status); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { recordset } = await request.query(`
    SELECT ${DOCUMENT_COLUMNS} FROM log.StockCountDocument
    ${whereSql}
    ORDER BY CreatedAtUtc DESC
  `);
  return recordset;
}

// One open/pending/approved count per (CountType, StorageLocation) is all the
// transfer-request guard needs to find — used by lib/stockCountGuard.js.
export async function findActiveCountForLocation(storageLocation) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('storageLocation', sql.NVarChar(4), storageLocation)
    .query(`
      SELECT TOP 1 CountId, CountType, Status
      FROM log.StockCountDocument
      WHERE StorageLocation = @storageLocation
        AND CountType <> 'PTFE_WEEKLY'
        AND Status IN ('Open', 'PendingApproval', 'Approved')
      ORDER BY CreatedAtUtc DESC
    `);
  return recordset[0] || null;
}

export async function getPtfeCountForWeek(weekStartDate) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('weekStartDate', sql.Date, weekStartDate)
    .query(`
      SELECT ${DOCUMENT_COLUMNS} FROM log.StockCountDocument
      WHERE CountType = 'PTFE_WEEKLY' AND WeekStartDate = @weekStartDate
    `);
  return recordset[0] || null;
}

// ── Count documents — writes ─────────────────────────────────────────────────

export async function createCountDocument({
  countType, storageLocation, weekStartDate, createdBy, createdByUserId,
}) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('countType',       sql.NVarChar(20), countType)
    .input('storageLocation', sql.NVarChar(4),  storageLocation || null)
    .input('weekStartDate',   sql.Date,         weekStartDate || null)
    .input('createdBy',       sql.NVarChar(100), createdBy || null)
    .input('createdByUserId', sql.Int,          createdByUserId ?? null)
    .input('status',           sql.NVarChar(20), 'Open')
    .query(`
      INSERT INTO log.StockCountDocument
        (CountType, StorageLocation, WeekStartDate, CreatedBy, CreatedByUserId, Status)
      OUTPUT INSERTED.CountId
      VALUES (@countType, @storageLocation, @weekStartDate, @createdBy, @createdByUserId, @status)
    `);
  return recordset[0].CountId;
}

// Idempotent PTFE-week creation — the cron pre-warms this, GET
// /counts/current-ptfe calls it lazily too, so a missed cron tick never
// blocks the week's count from existing. The filtered unique index
// (UQ_StockCountDocument_PtfeWeek) is the real guarantee against a race
// between the two callers; this check-then-insert is just the common path.
export async function getOrCreatePtfeCountForWeek(weekStartDate) {
  const existing = await getPtfeCountForWeek(weekStartDate);
  if (existing) return { countId: existing.CountId, created: false };
  try {
    const countId = await createCountDocument({
      countType: 'PTFE_WEEKLY', storageLocation: null, weekStartDate, createdBy: null, createdByUserId: null,
    });
    return { countId, created: true };
  } catch (err) {
    // UQ_StockCountDocument_PtfeWeek collision — another caller (cron vs. a
    // near-simultaneous page load) won the race; fetch what it created.
    const winner = await getPtfeCountForWeek(weekStartDate);
    if (winner) return { countId: winner.CountId, created: false };
    throw err;
  }
}

export async function updateCountStatus(countId, status, extra = {}) {
  const pool = await getPool();
  const request = pool.request()
    .input('countId', sql.Int, countId)
    .input('status',  sql.NVarChar(20), status);

  const sets = ['Status = @status'];
  if (extra.submittedBy !== undefined) { sets.push('SubmittedBy = @submittedBy, SubmittedAtUtc = getutcdate()'); request.input('submittedBy', sql.NVarChar(100), extra.submittedBy); }
  if (extra.approvedBy  !== undefined) { sets.push('ApprovedBy = @approvedBy, ApprovedAtUtc = getutcdate()');   request.input('approvedBy',  sql.NVarChar(100), extra.approvedBy); }
  if (extra.rejectedBy  !== undefined) { sets.push('RejectedBy = @rejectedBy, RejectedAtUtc = getutcdate(), RejectionReason = @rejectionReason'); request.input('rejectedBy', sql.NVarChar(100), extra.rejectedBy); request.input('rejectionReason', sql.NVarChar(500), extra.rejectionReason || null); }
  if (extra.reopenedBy  !== undefined) { sets.push('ReopenedBy = @reopenedBy, ReopenedAtUtc = getutcdate()');   request.input('reopenedBy',  sql.NVarChar(100), extra.reopenedBy); }
  if (extra.postedByUserId !== undefined) { sets.push('PostedByUserId = @postedByUserId, PostedAtUtc = getutcdate()'); request.input('postedByUserId', sql.Int, extra.postedByUserId); }

  const { recordset } = await request.query(`
    UPDATE log.StockCountDocument SET ${sets.join(', ')}
    OUTPUT INSERTED.CountId
    WHERE CountId = @countId
  `);
  return recordset.length > 0;
}

// ── Count lines ───────────────────────────────────────────────────────────────

export async function listCountLines(countId) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('countId', sql.Int, countId)
    .query(`SELECT ${LINE_COLUMNS} FROM log.StockCountLine WHERE CountId = @countId ORDER BY LineId`);
  return recordset;
}

export async function listInvalidLines(countId) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('countId', sql.Int, countId)
    .query(`SELECT ${LINE_COLUMNS} FROM log.StockCountLine WHERE CountId = @countId AND IsInvalidMaterial = 1 ORDER BY LineId`);
  return recordset;
}

export async function countHasInvalidLines(countId) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('countId', sql.Int, countId)
    .query(`SELECT TOP 1 1 AS x FROM log.StockCountLine WHERE CountId = @countId AND IsInvalidMaterial = 1`);
  return recordset.length > 0;
}

export async function countHasIncompleteBins(countId) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('countId', sql.Int, countId)
    .query(`
      SELECT TOP 1 1 AS x FROM log.StockCountLine
      WHERE CountId = @countId AND BinCompletedAtUtc IS NULL
    `);
  return recordset.length > 0;
}

// Every OTHER valid (IsInvalidMaterial = 0) line already in this count for
// the same (Material, StorageType, Bin) "group" — PRODUCTION has no
// StorageType/Bin (both NULL on every line there), so its grouping is
// Material-only, which is correct: 1716 has no bin concept to split on.
// Used to fold a group's SAP comparison across however many lines an
// operator ends up entering for the same physical location, instead of
// comparing each line independently against the full SAP quantity (see
// addCountLine's header comment for why that was a real bug).
export async function getGroupSiblingLines(countId, material, storageType, bin, excludeLineId = null) {
  const pool = await getPool();
  const request = pool.request()
    .input('countId', sql.Int, countId)
    .input('material', sql.NVarChar(18), material)
    .input('storageType', sql.NVarChar(3), storageType || null)
    .input('bin', sql.NVarChar(10), bin || null);
  let excludeClause = '';
  if (excludeLineId != null) {
    request.input('excludeLineId', sql.Int, excludeLineId);
    excludeClause = 'AND LineId <> @excludeLineId';
  }
  const { recordset } = await request.query(`
    SELECT LineId, CountedQty
    FROM log.StockCountLine
    WHERE CountId = @countId AND Material = @material
      AND ((StorageType = @storageType) OR (StorageType IS NULL AND @storageType IS NULL))
      AND ((Bin = @bin) OR (Bin IS NULL AND @bin IS NULL))
      AND IsInvalidMaterial = 0
      ${excludeClause}
  `);
  return recordset;
}

// Zeroes VarianceQty/VarianceValue on lines superseded by a newer line (or a
// just-corrected line) for the same group — see addCountLine's header
// comment. SapQty/CountedQty are left untouched (still the real SAP figure
// and what was actually physically counted on that line, for the record);
// only the *variance* attribution moves to whichever line most recently
// closed out the group's running total, so the group's variance is never
// double- (or triple-, or zero-) counted across its lines.
export async function zeroLineVariances(lineIds) {
  if (!lineIds || !lineIds.length) return;
  const pool = await getPool();
  const request = pool.request();
  const placeholders = lineIds.map((id, i) => {
    request.input(`id${i}`, sql.Int, id);
    return `@id${i}`;
  });
  await request.query(`
    UPDATE log.StockCountLine SET VarianceQty = 0, VarianceValue = 0, UpdatedAtUtc = getutcdate()
    WHERE LineId IN (${placeholders.join(',')})
  `);
}

export async function getCountLineById(lineId) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('lineId', sql.Int, lineId)
    .query(`SELECT ${LINE_COLUMNS} FROM log.StockCountLine WHERE LineId = @lineId`);
  return recordset[0] || null;
}

// material/isInvalidMaterial/isBatchManaged/sapQty/unitPrice are all resolved
// by the caller (routes/stockcount.js — material lookup + SAP comparison
// query) before calling this; this layer just persists the frozen snapshot,
// per the migration's "freeze figures at entry/comparison time" convention.
//
// countedQty is this line's own physical entry (what's displayed/audited).
// cumulativeCountedQty is what variance is actually computed FROM — the
// running total of every OTHER valid line already in this line's
// (Material, StorageType, Bin) group plus this one — defaulting to
// countedQty itself when this is the first/only line in its group. Two
// count lines for the same material/bin used to each get compared
// independently against the *same* full SAP quantity: entering 12,000kg
// twice against a bin SAP also showed 12,000kg in reported "matched" on
// both lines, and a third 6,000kg line then showed a spurious 6,000kg
// *shortfall* instead of the real ~18,000kg *surplus* the three lines
// actually represented together (30,000kg counted vs. 12,000kg in SAP).
// The caller (routes/stockcount.js) is responsible for computing
// cumulativeCountedQty via getGroupSiblingLines and for zeroing out the
// group's prior lines via zeroLineVariances immediately after this call,
// so only ever one line in a group carries the group's live variance at
// any moment — see routes/stockcount.js's POST /counts/:id/lines.
export async function addCountLine(countId, {
  material, materialText, uom, namedLocation, storageType, bin, ticketNumber,
  countedQty, cumulativeCountedQty, sapQty, unitPrice, isInvalidMaterial, isBatchManaged, enteredBy,
}) {
  const varianceBasis = cumulativeCountedQty ?? countedQty;
  const varianceQty = sapQty != null ? varianceBasis - sapQty : null;
  const varianceValue = (varianceQty != null && unitPrice != null) ? varianceQty * unitPrice : null;

  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('countId',       sql.Int, countId)
    .input('material',      sql.NVarChar(18), material)
    .input('materialText',  sql.NVarChar(80), materialText || null)
    .input('uom',            sql.NVarChar(3),  uom || null)
    .input('namedLocation',  sql.NVarChar(50), namedLocation || null)
    .input('storageType',     sql.NVarChar(3),  storageType || null)
    .input('bin',              sql.NVarChar(10), bin || null)
    .input('ticketNumber',      sql.NVarChar(30), ticketNumber || null)
    .input('countedQty',         sql.Decimal(15, 3), countedQty)
    .input('sapQty',              sql.Decimal(15, 3), sapQty ?? null)
    .input('varianceQty',          sql.Decimal(15, 3), varianceQty)
    .input('unitPrice',             sql.Decimal(15, 4), unitPrice ?? null)
    .input('varianceValue',          sql.Decimal(18, 2), varianceValue)
    .input('isInvalidMaterial',       sql.Bit, isInvalidMaterial ? 1 : 0)
    .input('isBatchManaged',           sql.Bit, isBatchManaged ? 1 : 0)
    .input('enteredBy',                 sql.NVarChar(100), enteredBy)
    .query(`
      INSERT INTO log.StockCountLine
        (CountId, Material, MaterialText, Uom, NamedLocation, StorageType, Bin, TicketNumber,
         CountedQty, SapQty, VarianceQty, UnitPrice, VarianceValue,
         IsInvalidMaterial, IsBatchManaged, EnteredBy)
      OUTPUT INSERTED.LineId
      VALUES
        (@countId, @material, @materialText, @uom, @namedLocation, @storageType, @bin, @ticketNumber,
         @countedQty, @sapQty, @varianceQty, @unitPrice, @varianceValue,
         @isInvalidMaterial, @isBatchManaged, @enteredBy)
    `);
  return recordset[0].LineId;
}

// The inline correct-and-clear action from the Invalid Materials view —
// re-resolves material/uom/price against the snapshot and flips
// IsInvalidMaterial off. Caller re-validates the new material code and
// passes the resolved fields in, same division of responsibility as addCountLine.
// Also resolves this line into its (now-known-valid) material's SAP
// comparison and group variance — a correction used to just clear
// IsInvalidMaterial and leave SapQty/VarianceQty/VarianceValue at their
// insert-time NULLs forever, silently excluding the corrected line from
// every report/finance total. cumulativeCountedQty/sapQty/isBatchManaged
// are resolved by the caller the same way as addCountLine's — see
// routes/stockcount.js's PUT /counts/:id/invalid-lines/:lineId, which also
// zeroes the line's group siblings via zeroLineVariances immediately after.
export async function correctInvalidMaterialLine(lineId, {
  material, materialText, uom, unitPrice, isInvalidMaterial,
  countedQty, cumulativeCountedQty, sapQty, isBatchManaged,
}) {
  const varianceBasis = cumulativeCountedQty ?? countedQty;
  const varianceQty = sapQty != null && varianceBasis != null ? varianceBasis - sapQty : null;
  const varianceValue = (varianceQty != null && unitPrice != null) ? varianceQty * unitPrice : null;

  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('lineId',       sql.Int, lineId)
    .input('material',     sql.NVarChar(18), material)
    .input('materialText', sql.NVarChar(80), materialText || null)
    .input('uom',           sql.NVarChar(3),  uom || null)
    .input('unitPrice',      sql.Decimal(15, 4), unitPrice ?? null)
    .input('isInvalidMaterial', sql.Bit, isInvalidMaterial ? 1 : 0)
    .input('sapQty',             sql.Decimal(15, 3), sapQty ?? null)
    .input('varianceQty',         sql.Decimal(15, 3), varianceQty)
    .input('varianceValue',        sql.Decimal(18, 2), varianceValue)
    .input('isBatchManaged',        sql.Bit, isBatchManaged ? 1 : 0)
    .query(`
      UPDATE log.StockCountLine
        SET Material = @material, MaterialText = @materialText, Uom = @uom,
            UnitPrice = @unitPrice, IsInvalidMaterial = @isInvalidMaterial,
            SapQty = @sapQty, VarianceQty = @varianceQty, VarianceValue = @varianceValue,
            IsBatchManaged = @isBatchManaged,
            UpdatedAtUtc = getutcdate()
      OUTPUT INSERTED.LineId
      WHERE LineId = @lineId
    `);
  return recordset.length > 0;
}

// Remediation for lines entered before the group-variance fix above (or any
// count whose lines otherwise drifted out of the "only the group's most-
// recently-entered line carries live variance" invariant) — regroups every
// valid line by (Material, StorageType, Bin), replays them in LineId (entry)
// order, and re-zeroes/re-attributes variance exactly as addCountLine/
// correctInvalidMaterialLine do for a newly-added line. Reuses each group's
// own most-recently-entered SapQty as the group's SAP baseline rather than
// re-querying SAP live — that figure was already a real SAP snapshot at the
// time that line was entered, and reusing it keeps this a DB-only operation
// (no SapServer round-trips, safe to run from routes/stockcount.js's
// POST /counts/:id/recompute).
export async function recomputeGroupVariances(countId) {
  const pool = await getPool();
  const { recordset: lines } = await pool.request()
    .input('countId', sql.Int, countId)
    .query(`
      SELECT LineId, Material, StorageType, Bin, CountedQty, SapQty, UnitPrice
      FROM log.StockCountLine
      WHERE CountId = @countId AND IsInvalidMaterial = 0
      ORDER BY LineId
    `);

  const groups = new Map();
  for (const line of lines) {
    const key = `${line.Material}::${line.StorageType ?? ''}::${line.Bin ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
  }

  let lineCount = 0;
  for (const groupLines of groups.values()) {
    const sapQty = groupLines[groupLines.length - 1].SapQty;
    if (sapQty == null) continue; // no SAP comparison on this group at all — nothing to recompute

    let cumulative = 0;
    for (let i = 0; i < groupLines.length; i++) {
      cumulative += Number(groupLines[i].CountedQty);
      const isLast = i === groupLines.length - 1;
      const varianceQty = isLast ? cumulative - Number(sapQty) : 0;
      const unitPrice = groupLines[i].UnitPrice;
      const varianceValue = unitPrice != null ? varianceQty * Number(unitPrice) : null;

      await pool.request()
        .input('lineId', sql.Int, groupLines[i].LineId)
        .input('varianceQty', sql.Decimal(15, 3), varianceQty)
        .input('varianceValue', sql.Decimal(18, 2), varianceValue)
        .query(`
          UPDATE log.StockCountLine SET VarianceQty = @varianceQty, VarianceValue = @varianceValue, UpdatedAtUtc = getutcdate()
          WHERE LineId = @lineId
        `);
      lineCount++;
    }
  }

  return { groupCount: groups.size, lineCount };
}

export async function markBinComplete(countId, storageType, bin, completedBy) {
  const pool = await getPool();
  const { rowsAffected } = await pool.request()
    .input('countId',     sql.Int, countId)
    .input('storageType', sql.NVarChar(3), storageType)
    .input('bin',          sql.NVarChar(10), bin)
    .input('completedBy',   sql.NVarChar(100), completedBy)
    .query(`
      UPDATE log.StockCountLine
        SET BinCompletedBy = @completedBy, BinCompletedAtUtc = getutcdate()
      WHERE CountId = @countId AND StorageType = @storageType AND Bin = @bin AND BinCompletedAtUtc IS NULL
    `);
  return rowsAffected[0] > 0;
}

// ── Reporting ─────────────────────────────────────────────────────────────────

export async function getCountReportByMaterial(countId) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('countId', sql.Int, countId)
    .query(`
      SELECT Material, MAX(MaterialText) AS MaterialText, MAX(Uom) AS Uom,
             SUM(CountedQty) AS TotalCountedQty, SUM(SapQty) AS TotalSapQty,
             SUM(VarianceQty) AS TotalVarianceQty, SUM(VarianceValue) AS TotalVarianceValue
      FROM log.StockCountLine
      WHERE CountId = @countId
      GROUP BY Material
      ORDER BY ABS(SUM(VarianceValue)) DESC
    `);
  return recordset;
}

export async function getCountReportByMaterialAndBin(countId) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('countId', sql.Int, countId)
    .query(`
      SELECT ${LINE_COLUMNS}
      FROM log.StockCountLine
      WHERE CountId = @countId
      ORDER BY Material, StorageType, Bin
    `);
  return recordset;
}

// ── Historical reporting (across every count, not just one) ─────────────────
//
// Feeds the finance "Stock Adjustments" tile's gain/loss history and the
// warehouse-facing Stock Count Accuracy report — separate from
// getCountReportByMaterial/getCountReportByMaterialAndBin above, which are
// both scoped to a single count. Date range filters on SubmittedAtUtc (the
// point a count left 'Open' and became "final" from a reporting point of
// view) — present on everything except still-in-progress Open counts, which
// neither report includes anyway.

function addDateRangeFilter(request, where, column, { from, to } = {}) {
  if (from) { where.push(`${column} >= @from`); request.input('from', sql.DateTime, new Date(from)); }
  if (to)   { where.push(`${column} <  @to`);   request.input('to',   sql.DateTime, new Date(to)); }
}

// Value of gains/losses across every count that reached an approval
// decision (Approved/Posted). Rejected counts are deliberately excluded
// here — they never had a real financial impact — unlike
// getWarehouseAccuracyReport below, which cares whether the physical count
// matched SAP regardless of what finance later decided.
export async function getFinanceReport({ from, to } = {}) {
  const pool = await getPool();

  const totalsRequest = pool.request();
  const totalsWhere = [`d.Status IN ('Approved','Posted')`, `l.VarianceValue IS NOT NULL`];
  addDateRangeFilter(totalsRequest, totalsWhere, 'd.SubmittedAtUtc', { from, to });
  const { recordset: totalsRows } = await totalsRequest.query(`
    SELECT
      SUM(CASE WHEN l.VarianceValue > 0 THEN l.VarianceValue ELSE 0 END) AS TotalGain,
      SUM(CASE WHEN l.VarianceValue < 0 THEN l.VarianceValue ELSE 0 END) AS TotalLoss
    FROM log.StockCountLine l JOIN log.StockCountDocument d ON d.CountId = l.CountId
    WHERE ${totalsWhere.join(' AND ')}
  `);

  const byMaterialRequest = pool.request();
  const byMaterialWhere = [`d.Status IN ('Approved','Posted')`, `l.VarianceValue IS NOT NULL`];
  addDateRangeFilter(byMaterialRequest, byMaterialWhere, 'd.SubmittedAtUtc', { from, to });
  const { recordset: byMaterial } = await byMaterialRequest.query(`
    SELECT l.Material, MAX(l.MaterialText) AS MaterialText,
           SUM(l.VarianceValue) AS NetValue, SUM(ABS(l.VarianceValue)) AS AbsValue
    FROM log.StockCountLine l JOIN log.StockCountDocument d ON d.CountId = l.CountId
    WHERE ${byMaterialWhere.join(' AND ')}
    GROUP BY l.Material
    ORDER BY AbsValue DESC
  `);

  const byBinRequest = pool.request();
  const byBinWhere = [`d.Status IN ('Approved','Posted')`, `l.VarianceValue IS NOT NULL`];
  addDateRangeFilter(byBinRequest, byBinWhere, 'd.SubmittedAtUtc', { from, to });
  const { recordset: byBin } = await byBinRequest.query(`
    SELECT l.StorageType, l.Bin,
           SUM(l.VarianceValue) AS NetValue, SUM(ABS(l.VarianceValue)) AS AbsValue
    FROM log.StockCountLine l JOIN log.StockCountDocument d ON d.CountId = l.CountId
    WHERE ${byBinWhere.join(' AND ')}
    GROUP BY l.StorageType, l.Bin
    ORDER BY AbsValue DESC
  `);

  const countsRequest = pool.request();
  const countsWhere = [`d.Status IN ('Approved','Posted','Rejected')`];
  addDateRangeFilter(countsRequest, countsWhere, 'd.SubmittedAtUtc', { from, to });
  const { recordset: counts } = await countsRequest.query(`
    SELECT d.CountId, d.CountType, d.StorageLocation, d.Status,
           d.SubmittedAtUtc, d.ApprovedAtUtc, d.PostedAtUtc, d.RejectedAtUtc,
           SUM(l.VarianceValue) AS NetValue
    FROM log.StockCountDocument d LEFT JOIN log.StockCountLine l ON l.CountId = d.CountId
    WHERE ${countsWhere.join(' AND ')}
    GROUP BY d.CountId, d.CountType, d.StorageLocation, d.Status,
             d.SubmittedAtUtc, d.ApprovedAtUtc, d.PostedAtUtc, d.RejectedAtUtc
    ORDER BY d.CountId DESC
  `);

  return { totals: totalsRows[0] || { TotalGain: 0, TotalLoss: 0 }, byMaterial, byBin, counts };
}

// Counting accuracy (was stock in the right place/quantity) across every
// count that was at least submitted — includes Rejected counts, unlike
// getFinanceReport above, since a rejected count still tells you whether
// the physical count matched SAP, which is the whole point here.
export async function getWarehouseAccuracyReport({ from, to } = {}) {
  const pool = await getPool();

  const overallRequest = pool.request();
  const overallWhere = [`d.Status IN ('PendingApproval','Approved','Rejected','Posted')`, `l.VarianceQty IS NOT NULL`];
  addDateRangeFilter(overallRequest, overallWhere, 'd.SubmittedAtUtc', { from, to });
  const { recordset: overallRows } = await overallRequest.query(`
    SELECT COUNT(*) AS TotalLines,
           SUM(CASE WHEN l.VarianceQty = 0 THEN 1 ELSE 0 END) AS AccurateLines
    FROM log.StockCountLine l JOIN log.StockCountDocument d ON d.CountId = l.CountId
    WHERE ${overallWhere.join(' AND ')}
  `);

  const countsRequest = pool.request();
  const countsWhere = [`d.Status IN ('PendingApproval','Approved','Rejected','Posted')`, `l.VarianceQty IS NOT NULL`];
  addDateRangeFilter(countsRequest, countsWhere, 'd.SubmittedAtUtc', { from, to });
  const { recordset: counts } = await countsRequest.query(`
    SELECT d.CountId, d.CountType, d.StorageLocation, d.Status, d.SubmittedAtUtc,
           COUNT(l.LineId) AS TotalLines,
           SUM(CASE WHEN l.VarianceQty = 0 THEN 1 ELSE 0 END) AS AccurateLines
    FROM log.StockCountDocument d JOIN log.StockCountLine l ON l.CountId = d.CountId
    WHERE ${countsWhere.join(' AND ')}
    GROUP BY d.CountId, d.CountType, d.StorageLocation, d.Status, d.SubmittedAtUtc
    ORDER BY d.CountId DESC
  `);

  const byLocationRequest = pool.request();
  const byLocationWhere = [`d.Status IN ('PendingApproval','Approved','Rejected','Posted')`, `l.VarianceQty IS NOT NULL`];
  addDateRangeFilter(byLocationRequest, byLocationWhere, 'd.SubmittedAtUtc', { from, to });
  const { recordset: byLocation } = await byLocationRequest.query(`
    SELECT l.StorageType, l.Bin, COUNT(*) AS TotalLines,
           SUM(CASE WHEN l.VarianceQty <> 0 THEN 1 ELSE 0 END) AS DiscrepancyLines
    FROM log.StockCountLine l JOIN log.StockCountDocument d ON d.CountId = l.CountId
    WHERE ${byLocationWhere.join(' AND ')}
    GROUP BY l.StorageType, l.Bin
    ORDER BY (SUM(CASE WHEN l.VarianceQty <> 0 THEN 1.0 ELSE 0 END) / COUNT(*)) DESC
  `);

  return { overall: overallRows[0] || { TotalLines: 0, AccurateLines: 0 }, counts, byLocation };
}

// ── Finished Goods Count — session (reuses StockCountDocument as a pure
// active-session marker, no lines/approval fields — see the migration's
// header comment) ────────────────────────────────────────────────────────────

export async function getActiveFgSession() {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT TOP 1 ${DOCUMENT_COLUMNS} FROM log.StockCountDocument
    WHERE CountType = 'FINISHED_GOODS' AND Status = 'Open'
    ORDER BY CreatedAtUtc DESC
  `);
  return recordset[0] || null;
}

// ── Finished Goods Count — scans ─────────────────────────────────────────────

export async function recordFgScan({ material, batch, expectedFound, scannedStorageType, scannedBin, outcome, scannedBy }) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('material',           sql.NVarChar(18), material)
    .input('batch',               sql.NVarChar(10), batch)
    .input('expectedFound',        sql.Bit, expectedFound ? 1 : 0)
    .input('scannedStorageType',    sql.NVarChar(3), scannedStorageType)
    .input('scannedBin',             sql.NVarChar(10), scannedBin)
    .input('outcome',                 sql.NVarChar(20), outcome)
    .input('scannedBy',                sql.NVarChar(100), scannedBy)
    .query(`
      INSERT INTO log.StockCountFgScan
        (Material, Batch, ExpectedFound, ScannedStorageType, ScannedBin, Outcome, ScannedBy)
      OUTPUT INSERTED.ScanId
      VALUES (@material, @batch, @expectedFound, @scannedStorageType, @scannedBin, @outcome, @scannedBy)
    `);
  return recordset[0].ScanId;
}

// Batches already confirmed present (Outcome='CorrectBin') in a specific bin
// — used by confirmBinFullyScanned to work out which of SAP's expected
// batches for that bin were never actually scanned there.
export async function listConfirmedBatchesInBin(storageType, bin) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('storageType', sql.NVarChar(3), storageType)
    .input('bin',          sql.NVarChar(10), bin)
    .query(`
      SELECT DISTINCT Material, Batch FROM log.StockCountFgScan
      WHERE ScannedStorageType = @storageType AND ScannedBin = @bin AND Outcome = 'CorrectBin'
    `);
  return recordset;
}

// ── Finished Goods Count — discrepancies (feeds the Stock Investigations
// "Stock Count Discrepancies" panel) ─────────────────────────────────────────

export async function findOpenDiscrepancy(material, batch) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('material', sql.NVarChar(18), material)
    .input('batch',     sql.NVarChar(10), batch)
    .query(`
      SELECT TOP 1 DiscrepancyId FROM log.StockCountDiscrepancy
      WHERE Material = @material AND Batch = @batch AND Status = 'Open'
    `);
  return recordset[0] || null;
}

export async function createDiscrepancy({
  material, batch, kind, expectedStorageType, expectedBin, foundStorageType, foundBin, sourceScanId,
}) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('material',            sql.NVarChar(18), material)
    .input('batch',                sql.NVarChar(10), batch)
    .input('kind',                   sql.NVarChar(20), kind)
    .input('expectedStorageType',      sql.NVarChar(3), expectedStorageType || null)
    .input('expectedBin',                sql.NVarChar(10), expectedBin || null)
    .input('foundStorageType',              sql.NVarChar(3), foundStorageType || null)
    .input('foundBin',                        sql.NVarChar(10), foundBin || null)
    .input('sourceScanId',                      sql.Int, sourceScanId ?? null)
    .query(`
      INSERT INTO log.StockCountDiscrepancy
        (Material, Batch, Kind, ExpectedStorageType, ExpectedBin, FoundStorageType, FoundBin, SourceScanId, Status)
      OUTPUT INSERTED.DiscrepancyId
      VALUES (@material, @batch, @kind, @expectedStorageType, @expectedBin, @foundStorageType, @foundBin, @sourceScanId, 'Open')
    `);
  return recordset[0].DiscrepancyId;
}

export async function resolveDiscrepancy(discrepancyId, status, { resolvedBy, resolutionTransferOrderNumber } = {}) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('discrepancyId',                sql.Int, discrepancyId)
    .input('status',                         sql.NVarChar(20), status)
    .input('resolvedBy',                       sql.NVarChar(100), resolvedBy || null)
    .input('resolutionTransferOrderNumber',      sql.NVarChar(10), resolutionTransferOrderNumber || null)
    .query(`
      UPDATE log.StockCountDiscrepancy
        SET Status = @status, ResolvedBy = @resolvedBy, ResolvedAtUtc = getutcdate(),
            ResolutionTransferOrderNumber = @resolutionTransferOrderNumber
      OUTPUT INSERTED.DiscrepancyId
      WHERE DiscrepancyId = @discrepancyId AND Status = 'Open'
    `);
  return recordset.length > 0;
}

export async function getDiscrepancy(discrepancyId) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('discrepancyId', sql.Int, discrepancyId)
    .query(`SELECT * FROM log.StockCountDiscrepancy WHERE DiscrepancyId = @discrepancyId`);
  return recordset[0] || null;
}

export async function listOpenDiscrepancies() {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT * FROM log.StockCountDiscrepancy WHERE Status = 'Open' ORDER BY CreatedAtUtc ASC
  `);
  return recordset;
}
