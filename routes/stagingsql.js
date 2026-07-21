// routes/stagingsql.js
//
// DB layer for Staging Post — material requisitions from Production to
// Stores. See sql/migrate_staging_post.sql for the full schema + workflow
// writeup. DATETIME (not DATE) throughout, matching every other date column
// in this project — this SQL Server instance predates the DATE type.

import sql from 'mssql';
import { sqlConfig } from '../config.js';

async function getPool() {
  return await sql.connect(sqlConfig);
}

// Delivered quantity within this fraction of requested counts as "close
// enough" to offer Stores the confirm-complete/leave-open choice. Outside
// it, the request just stays Open — see recordStagingDelivery below and the
// migration's header note for the full reasoning.
export const WITHIN_TOLERANCE_PCT = 0.10;

const REQUEST_COLUMNS = `
  RequestId, Material, MaterialText, Uom, QuantityRequested, QuantityDelivered,
  Location, RequestedBatch, DueAtUtc, Notes, Status,
  RequestedBy, RequestedAtUtc, CompletedBy, CompletedAtUtc,
  CancelledBy, CancelledAtUtc, UpdatedAtUtc
`;

// ── Material search ───────────────────────────────────────────────────────────
//
// routes/performance.js's /turns-valclass?search= does the same lookup
// against the same table, but it's gated behind LOG_MRP — a permission
// production floor staff won't hold. This is the same read-only data with no
// gate beyond being logged in, so Staging Post's request form (used by any
// production operator) has its own way to look a material up.

export async function searchMaterials(search) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('search', sql.VarChar(42), `%${search}%`)
    .query(`
      SELECT TOP 30 Material AS material, MaterialText AS materialText, Uom AS uom
      FROM dbo.TurnsValClassSnapshot
      WHERE Material LIKE @search OR MaterialText LIKE @search
      ORDER BY Material
    `);
  return recordset;
}

// ── Requests — reads ─────────────────────────────────────────────────────────

export async function listOpenStagingRequests() {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT ${REQUEST_COLUMNS} FROM dbo.StagingRequest
    WHERE Status = 'Open'
    ORDER BY DueAtUtc ASC
  `);
  return recordset;
}

// Lightweight tile-badge summary — count of open requests and how many of
// those are overdue (DueAtUtc already passed), without pulling the full
// open-request payload just to count it. Same DueAtUtc-comparison idiom as
// computeStagingKpis' OnTimeCount, just against "now" instead of CompletedAtUtc.
export async function getStagingOpenSummary() {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT
      COUNT(*) AS OpenCount,
      SUM(CASE WHEN DueAtUtc < GETUTCDATE() THEN 1 ELSE 0 END) AS OverdueCount
    FROM dbo.StagingRequest
    WHERE Status = 'Open'
  `);
  const row = recordset[0] || {};
  return { openCount: row.OpenCount || 0, overdueCount: row.OverdueCount || 0 };
}

// Production's tracking view — everything, open requests first (by due
// date), then closed ones most-recent-first so a just-completed/cancelled
// request doesn't immediately vanish off the bottom.
export async function listStagingRequests() {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT ${REQUEST_COLUMNS} FROM dbo.StagingRequest
    ORDER BY
      CASE WHEN Status = 'Open' THEN 0 ELSE 1 END,
      CASE WHEN Status = 'Open' THEN DueAtUtc END ASC,
      CASE WHEN Status <> 'Open' THEN RequestedAtUtc END DESC
  `);
  return recordset;
}

export async function getStagingRequestById(requestId) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('requestId', sql.Int, requestId)
    .query(`SELECT ${REQUEST_COLUMNS} FROM dbo.StagingRequest WHERE RequestId = @requestId`);
  return recordset[0] || null;
}

// Audit trail — completed + cancelled, optionally scoped to a date range
// (checked against RequestedAtUtc, so the report reflects "requests raised
// in this period" regardless of when they were eventually closed out).
export async function listCompletedStagingRequests({ from, to } = {}) {
  const pool = await getPool();
  const request = pool.request();
  const where = [`Status IN ('Completed', 'Cancelled')`];
  if (from) { where.push('RequestedAtUtc >= @from'); request.input('from', sql.DateTime, from); }
  if (to)   { where.push('RequestedAtUtc <  @to');   request.input('to',   sql.DateTime, to); }
  const { recordset } = await request.query(`
    SELECT ${REQUEST_COLUMNS} FROM dbo.StagingRequest
    WHERE ${where.join(' AND ')}
    ORDER BY RequestedAtUtc DESC
  `);
  return recordset;
}

// ── Requests — writes ────────────────────────────────────────────────────────

export async function createStagingRequest({
  material, materialText, uom, quantityRequested, location, requestedBatch,
  dueAtUtc, notes, requestedBy,
}) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('material',          sql.NVarChar(18),  material)
    .input('materialText',      sql.NVarChar(80),  materialText || null)
    .input('uom',                sql.NVarChar(3),   uom || null)
    .input('quantityRequested',   sql.Decimal(15, 3), quantityRequested)
    .input('location',             sql.NVarChar(100), location)
    .input('requestedBatch',        sql.NVarChar(10),  requestedBatch || null)
    .input('dueAtUtc',                sql.DateTime,      dueAtUtc)
    .input('notes',                    sql.NVarChar(500), notes || null)
    .input('requestedBy',               sql.NVarChar(100), requestedBy)
    .query(`
      INSERT INTO dbo.StagingRequest
        (Material, MaterialText, Uom, QuantityRequested, Location, RequestedBatch, DueAtUtc, Notes, RequestedBy)
      OUTPUT INSERTED.RequestId
      VALUES (@material, @materialText, @uom, @quantityRequested, @location, @requestedBatch, @dueAtUtc, @notes, @requestedBy)
    `);
  return recordset[0].RequestId;
}

// Only cancellable while still Open and nothing has been delivered against
// it yet — once Stores has acted, cancelling from under them would orphan a
// real transfer order. Returns false (not an error) if that condition isn't
// met, so the route can give a clear "can't cancel this one" message.
export async function cancelStagingRequest(requestId, cancelledBy) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('requestId',   sql.Int, requestId)
    .input('cancelledBy', sql.NVarChar(100), cancelledBy)
    .query(`
      UPDATE dbo.StagingRequest
        SET Status = 'Cancelled', CancelledBy = @cancelledBy, CancelledAtUtc = GETUTCDATE(), UpdatedAtUtc = GETUTCDATE()
      OUTPUT INSERTED.RequestId
      WHERE RequestId = @requestId AND Status = 'Open' AND QuantityDelivered = 0
    `);
  return recordset.length > 0;
}

export async function completeStagingRequest(requestId, completedBy) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('requestId',   sql.Int, requestId)
    .input('completedBy', sql.NVarChar(100), completedBy)
    .query(`
      UPDATE dbo.StagingRequest
        SET Status = 'Completed', CompletedBy = @completedBy, CompletedAtUtc = GETUTCDATE(), UpdatedAtUtc = GETUTCDATE()
      OUTPUT INSERTED.RequestId
      WHERE RequestId = @requestId AND Status = 'Open'
    `);
  return recordset.length > 0;
}

// ── Deliveries ────────────────────────────────────────────────────────────────

export async function listStagingRequestDeliveries(requestId) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('requestId', sql.Int, requestId)
    .query(`
      SELECT DeliveryId, RequestId, QuantityMoved, Batch,
             SourceStorageType, SourceBin, DestinationStorageType, DestinationBin,
             TransferOrderNumber, DeliveredBy, DeliveredAtUtc
      FROM dbo.StagingRequestDelivery
      WHERE RequestId = @requestId
      ORDER BY DeliveredAtUtc ASC
    `);
  return recordset;
}

// Records one delivery (one transfer order's worth), rolls it into the
// request's cumulative QuantityDelivered, and reports whether the new
// cumulative total is within WITHIN_TOLERANCE_PCT of what was requested —
// the route uses that flag to decide whether to offer Stores the
// confirm-complete/leave-open choice. Never changes Status itself; that's a
// separate, explicit completeStagingRequest call.
export async function recordStagingDelivery(requestId, {
  quantityMoved, batch, sourceStorageType, sourceBin,
  destinationStorageType, destinationBin, transferOrderNumber, deliveredBy,
}) {
  const pool = await getPool();
  const request = pool.request();
  await request
    .input('requestId',              sql.Int,           requestId)
    .input('quantityMoved',           sql.Decimal(15, 3), quantityMoved)
    .input('batch',                    sql.NVarChar(10),  batch || null)
    .input('sourceStorageType',         sql.NVarChar(3),   sourceStorageType || null)
    .input('sourceBin',                  sql.NVarChar(10),  sourceBin || null)
    .input('destinationStorageType',      sql.NVarChar(3),   destinationStorageType || null)
    .input('destinationBin',               sql.NVarChar(10),  destinationBin || null)
    .input('transferOrderNumber',           sql.NVarChar(10),  transferOrderNumber || null)
    .input('deliveredBy',                    sql.NVarChar(100), deliveredBy)
    .query(`
      INSERT INTO dbo.StagingRequestDelivery
        (RequestId, QuantityMoved, Batch, SourceStorageType, SourceBin, DestinationStorageType, DestinationBin, TransferOrderNumber, DeliveredBy)
      VALUES (@requestId, @quantityMoved, @batch, @sourceStorageType, @sourceBin, @destinationStorageType, @destinationBin, @transferOrderNumber, @deliveredBy)
    `);

  const updateResult = await pool.request()
    .input('requestId',      sql.Int, requestId)
    .input('quantityMoved',  sql.Decimal(15, 3), quantityMoved)
    .query(`
      UPDATE dbo.StagingRequest
        SET QuantityDelivered = QuantityDelivered + @quantityMoved, UpdatedAtUtc = GETUTCDATE()
      OUTPUT INSERTED.QuantityDelivered, INSERTED.QuantityRequested
      WHERE RequestId = @requestId
    `);

  const row = updateResult.recordset[0];
  const requested = Number(row.QuantityRequested);
  const delivered = Number(row.QuantityDelivered);
  const withinTolerance = requested > 0 && Math.abs(delivered - requested) / requested <= WITHIN_TOLERANCE_PCT;

  return { cumulativeDelivered: delivered, quantityRequested: requested, withinTolerance };
}

// ── KPIs (Completed requests only — Cancelled requests were never fulfilled,
// so they'd only distort on-time% and lead-time figures) ────────────────────

export async function computeStagingKpis({ from, to } = {}) {
  const pool = await getPool();
  const request = pool.request();
  const where = [`Status = 'Completed'`];
  if (from) { where.push('RequestedAtUtc >= @from'); request.input('from', sql.DateTime, from); }
  if (to)   { where.push('RequestedAtUtc <  @to');   request.input('to',   sql.DateTime, to); }
  const whereSql = where.join(' AND ');

  const { recordset: overallRows } = await request.query(`
    SELECT
      COUNT(*) AS CompletedCount,
      SUM(CASE WHEN CompletedAtUtc <= DueAtUtc THEN 1 ELSE 0 END) AS OnTimeCount,
      AVG(CAST(DATEDIFF(MINUTE, RequestedAtUtc, CompletedAtUtc) AS DECIMAL(15, 2))) / 60.0 AS AvgLeadTimeHours
    FROM dbo.StagingRequest
    WHERE ${whereSql}
  `);

  const request2 = pool.request();
  if (from) request2.input('from', sql.DateTime, from);
  if (to)   request2.input('to',   sql.DateTime, to);
  const { recordset: byMaterialRows } = await request2.query(`
    SELECT
      Material, MAX(MaterialText) AS MaterialText,
      COUNT(*) AS CompletedCount,
      SUM(CASE WHEN CompletedAtUtc <= DueAtUtc THEN 1 ELSE 0 END) AS OnTimeCount,
      AVG(CAST(DATEDIFF(MINUTE, RequestedAtUtc, CompletedAtUtc) AS DECIMAL(15, 2))) / 60.0 AS AvgLeadTimeHours
    FROM dbo.StagingRequest
    WHERE ${whereSql}
    GROUP BY Material
    ORDER BY Material
  `);

  return { overall: overallRows[0], byMaterial: byMaterialRows };
}

// ── Bin restrictions (Warehouse Supervisor config) ───────────────────────────

export async function listBinRestrictions() {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT RestrictionId, Material, StorageType, Bin, Notes, CreatedBy, CreatedAtUtc
    FROM dbo.StagingBinRestriction
    ORDER BY Material, StorageType, Bin
  `);
  return recordset;
}

export async function getBinRestrictionsForMaterial(material) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('material', sql.NVarChar(18), material)
    .query(`
      SELECT RestrictionId, Material, StorageType, Bin, Notes
      FROM dbo.StagingBinRestriction
      WHERE Material = @material
      ORDER BY StorageType, Bin
    `);
  return recordset;
}

export async function createBinRestriction({ material, storageType, bin, notes, createdBy }) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('material',    sql.NVarChar(18),  material)
    .input('storageType', sql.NVarChar(3),   storageType)
    .input('bin',          sql.NVarChar(10),  bin || null)
    .input('notes',         sql.NVarChar(200), notes || null)
    .input('createdBy',      sql.NVarChar(100), createdBy || null)
    .query(`
      INSERT INTO dbo.StagingBinRestriction (Material, StorageType, Bin, Notes, CreatedBy)
      OUTPUT INSERTED.RestrictionId
      VALUES (@material, @storageType, @bin, @notes, @createdBy)
    `);
  return recordset[0].RestrictionId;
}

export async function updateBinRestriction(restrictionId, { material, storageType, bin, notes }) {
  const pool = await getPool();
  await pool.request()
    .input('restrictionId', sql.Int,           restrictionId)
    .input('material',      sql.NVarChar(18),  material)
    .input('storageType',   sql.NVarChar(3),   storageType)
    .input('bin',            sql.NVarChar(10),  bin || null)
    .input('notes',           sql.NVarChar(200), notes || null)
    .query(`
      UPDATE dbo.StagingBinRestriction
        SET Material = @material, StorageType = @storageType, Bin = @bin, Notes = @notes
      WHERE RestrictionId = @restrictionId
    `);
}

export async function deleteBinRestriction(restrictionId) {
  const pool = await getPool();
  await pool.request().input('restrictionId', sql.Int, restrictionId)
    .query('DELETE FROM dbo.StagingBinRestriction WHERE RestrictionId = @restrictionId');
}
