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
  CountId, CountType, StorageLocation, TicketNumber, Status, WeekStartDate,
  CreatedBy, CreatedByUserId, CreatedAtUtc,
  SubmittedBy, SubmittedAtUtc,
  ApprovedBy, ApprovedAtUtc,
  RejectedBy, RejectedAtUtc, RejectionReason,
  ReopenedBy, ReopenedAtUtc,
  PostedByUserId, PostedAtUtc,
  Notes
`;

const LINE_COLUMNS = `
  LineId, CountId, Material, MaterialText, Uom, NamedLocation, StorageType, Bin,
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

// ── Location map (PTFE Weekly Cycle Count only) ──────────────────────────────

export async function listLocationMap() {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT MapId, NamedLocation, StorageType, Bin, IsActive, UpdatedBy, UpdatedAtUtc
    FROM log.StockCountLocationMap
    WHERE IsActive = 1
    ORDER BY NamedLocation
  `);
  return recordset;
}

export async function getLocationMapEntry(namedLocation) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('namedLocation', sql.NVarChar(50), namedLocation)
    .query(`
      SELECT MapId, NamedLocation, StorageType, Bin
      FROM log.StockCountLocationMap
      WHERE NamedLocation = @namedLocation AND IsActive = 1
    `);
  return recordset[0] || null;
}

// Upsert by NamedLocation — the caller (routes/stockcount.js) must validate
// StorageType/Bin against SAP LAGP before calling this; this layer only
// persists what it's given. Deactivates any prior active row for the same
// name rather than updating in place, so UpdatedBy/UpdatedAtUtc always
// reflect a real change and old mappings stay in the table for audit.
export async function upsertLocationMap(namedLocation, { storageType, bin, updatedBy }) {
  const pool = await getPool();
  await pool.request()
    .input('namedLocation', sql.NVarChar(50), namedLocation)
    .query(`
      UPDATE log.StockCountLocationMap SET IsActive = 0
      WHERE NamedLocation = @namedLocation AND IsActive = 1
    `);
  const { recordset } = await pool.request()
    .input('namedLocation', sql.NVarChar(50), namedLocation)
    .input('storageType',   sql.NVarChar(3),  storageType)
    .input('bin',            sql.NVarChar(10), bin)
    .input('updatedBy',       sql.NVarChar(100), updatedBy || null)
    .query(`
      INSERT INTO log.StockCountLocationMap (NamedLocation, StorageType, Bin, UpdatedBy)
      OUTPUT INSERTED.MapId
      VALUES (@namedLocation, @storageType, @bin, @updatedBy)
    `);
  return recordset[0].MapId;
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
  countType, storageLocation, ticketNumber, weekStartDate, createdBy, createdByUserId,
}) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('countType',       sql.NVarChar(20), countType)
    .input('storageLocation', sql.NVarChar(4),  storageLocation || null)
    .input('ticketNumber',    sql.NVarChar(30), ticketNumber || null)
    .input('weekStartDate',   sql.Date,         weekStartDate || null)
    .input('createdBy',       sql.NVarChar(100), createdBy || null)
    .input('createdByUserId', sql.Int,          createdByUserId ?? null)
    .input('status',           sql.NVarChar(20), 'Open')
    .query(`
      INSERT INTO log.StockCountDocument
        (CountType, StorageLocation, TicketNumber, WeekStartDate, CreatedBy, CreatedByUserId, Status)
      OUTPUT INSERTED.CountId
      VALUES (@countType, @storageLocation, @ticketNumber, @weekStartDate, @createdBy, @createdByUserId, @status)
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

// material/isInvalidMaterial/isBatchManaged/sapQty/unitPrice are all resolved
// by the caller (routes/stockcount.js — material lookup + SAP comparison
// query) before calling this; this layer just persists the frozen snapshot,
// per the migration's "freeze figures at entry/comparison time" convention.
export async function addCountLine(countId, {
  material, materialText, uom, namedLocation, storageType, bin,
  countedQty, sapQty, unitPrice, isInvalidMaterial, isBatchManaged, enteredBy,
}) {
  const varianceQty = sapQty != null ? countedQty - sapQty : null;
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
    .input('countedQty',        sql.Decimal(15, 3), countedQty)
    .input('sapQty',             sql.Decimal(15, 3), sapQty ?? null)
    .input('varianceQty',         sql.Decimal(15, 3), varianceQty)
    .input('unitPrice',            sql.Decimal(15, 4), unitPrice ?? null)
    .input('varianceValue',         sql.Decimal(18, 2), varianceValue)
    .input('isInvalidMaterial',      sql.Bit, isInvalidMaterial ? 1 : 0)
    .input('isBatchManaged',          sql.Bit, isBatchManaged ? 1 : 0)
    .input('enteredBy',                sql.NVarChar(100), enteredBy)
    .query(`
      INSERT INTO log.StockCountLine
        (CountId, Material, MaterialText, Uom, NamedLocation, StorageType, Bin,
         CountedQty, SapQty, VarianceQty, UnitPrice, VarianceValue,
         IsInvalidMaterial, IsBatchManaged, EnteredBy)
      OUTPUT INSERTED.LineId
      VALUES
        (@countId, @material, @materialText, @uom, @namedLocation, @storageType, @bin,
         @countedQty, @sapQty, @varianceQty, @unitPrice, @varianceValue,
         @isInvalidMaterial, @isBatchManaged, @enteredBy)
    `);
  return recordset[0].LineId;
}

// The inline correct-and-clear action from the Invalid Materials view —
// re-resolves material/uom/price against the snapshot and flips
// IsInvalidMaterial off. Caller re-validates the new material code and
// passes the resolved fields in, same division of responsibility as addCountLine.
export async function correctInvalidMaterialLine(lineId, { material, materialText, uom, unitPrice, isInvalidMaterial }) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('lineId',       sql.Int, lineId)
    .input('material',     sql.NVarChar(18), material)
    .input('materialText', sql.NVarChar(80), materialText || null)
    .input('uom',           sql.NVarChar(3),  uom || null)
    .input('unitPrice',      sql.Decimal(15, 4), unitPrice ?? null)
    .input('isInvalidMaterial', sql.Bit, isInvalidMaterial ? 1 : 0)
    .query(`
      UPDATE log.StockCountLine
        SET Material = @material, MaterialText = @materialText, Uom = @uom,
            UnitPrice = @unitPrice, IsInvalidMaterial = @isInvalidMaterial,
            UpdatedAtUtc = getutcdate()
      OUTPUT INSERTED.LineId
      WHERE LineId = @lineId
    `);
  return recordset.length > 0;
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
