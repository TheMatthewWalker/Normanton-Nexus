// routes/consignmentsql.js
//
// DB layer for the Vendor Consignment Tracker (Logistics > Material
// Planning). See sql/migrate_consignment_tracker.sql for the full schema +
// design writeup — especially the "UNDECLARED CONSUMPTION IS A BALANCE"
// section, which this file's getVendorBalance() implements directly.
//
// Reuses dbo.Vendor/dbo.VendorMaterial (already seeded from MRP2.xlsx —
// Chemours, Fothergill/FCF, Raaj all already exist there) rather than a
// separate vendor table — a vendor consignment-tracks the exact same
// materials it's already an MRP source for. DATETIME (not DATE) throughout,
// matching every other date column in this project.

import sql from 'mssql';
import { sqlConfig } from '../config.js';

async function getPool() {
  return await sql.connect(sqlConfig);
}

// ── Vendors + config ──────────────────────────────────────────────────────────

export async function listConsignmentVendors() {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT
      v.VendorId, v.VendorName, v.SapVendorNumber, v.Currency,
      ISNULL(cvc.TrackExpiry, 0)               AS TrackExpiry,
      cvc.ExpiryWarningDays, cvc.ExpiryDays,
      ISNULL(cvc.DefaultAllocationMethod, 'FIFO') AS DefaultAllocationMethod,
      ISNULL(cvc.Active, 1)                    AS Active,
      cvc.Notes, cvc.UpdatedAtUtc, cvc.UpdatedByUsername
    FROM dbo.ConsignmentVendorConfig cvc
    JOIN dbo.Vendor v ON v.VendorId = cvc.VendorId
    ORDER BY v.VendorName
  `);
  return recordset;
}

export async function getConsignmentVendor(vendorId) {
  const pool = await getPool();
  const { recordset } = await pool.request()
    .input('vendorId', sql.Int, vendorId)
    .query(`
      SELECT
        v.VendorId, v.VendorName, v.SapVendorNumber, v.Currency,
        ISNULL(cvc.TrackExpiry, 0)               AS TrackExpiry,
        cvc.ExpiryWarningDays, cvc.ExpiryDays,
        ISNULL(cvc.DefaultAllocationMethod, 'FIFO') AS DefaultAllocationMethod,
        ISNULL(cvc.Active, 1)                    AS Active,
        cvc.Notes
      FROM dbo.Vendor v
      LEFT JOIN dbo.ConsignmentVendorConfig cvc ON cvc.VendorId = v.VendorId
      WHERE v.VendorId = @vendorId
    `);
  return recordset[0] || null;
}

// Guarded upsert — dbo.ConsignmentVendorConfig.VendorId is the PK, so this is
// a plain existence-check-then-INSERT-or-UPDATE (no MERGE — SQL2005).
export async function upsertConsignmentVendorConfig(vendorId, body, username) {
  const pool = await getPool();
  const exists = await pool.request().input('vendorId', sql.Int, vendorId)
    .query('SELECT 1 FROM dbo.ConsignmentVendorConfig WHERE VendorId = @vendorId');

  const req = pool.request()
    .input('vendorId', sql.Int, vendorId)
    .input('trackExpiry', sql.Bit, !!body.trackExpiry)
    .input('expiryWarningDays', sql.Int, body.expiryWarningDays ?? null)
    // Calendar days from goods-receipt DocumentDate until stock must be
    // declared — SAP has no reliable expiry field for this material, so
    // this is what listConsignmentDeliveries/getDeclaration use to CALCULATE
    // ExpiryDate (DocumentDate + ExpiryDays) whenever nobody has manually
    // entered one on the delivery line. See migrate_consignment_expiry_days.sql.
    .input('expiryDays', sql.Int, body.expiryDays ?? null)
    .input('defaultAllocationMethod', sql.NVarChar(10), body.defaultAllocationMethod || 'FIFO')
    .input('active', sql.Bit, body.active === undefined ? true : !!body.active)
    .input('notes', sql.NVarChar(500), body.notes || null)
    .input('username', sql.NVarChar(80), username || null);

  if (exists.recordset.length) {
    await req.query(`
      UPDATE dbo.ConsignmentVendorConfig SET
        TrackExpiry = @trackExpiry, ExpiryWarningDays = @expiryWarningDays,
        ExpiryDays = @expiryDays,
        DefaultAllocationMethod = @defaultAllocationMethod, Active = @active,
        Notes = @notes, UpdatedAtUtc = GETUTCDATE(), UpdatedByUsername = @username
      WHERE VendorId = @vendorId
    `);
  } else {
    await req.query(`
      INSERT INTO dbo.ConsignmentVendorConfig
        (VendorId, TrackExpiry, ExpiryWarningDays, ExpiryDays, DefaultAllocationMethod, Active, Notes, UpdatedByUsername)
      VALUES
        (@vendorId, @trackExpiry, @expiryWarningDays, @expiryDays, @defaultAllocationMethod, @active, @notes, @username)
    `);
  }
  return getConsignmentVendor(vendorId);
}

export async function listVendorMaterials(vendorId) {
  const pool = await getPool();
  const { recordset } = await pool.request().input('vendorId', sql.Int, vendorId).query(`
    SELECT VendorMaterialId, Material, ScheduleAgreement
    FROM dbo.VendorMaterial WHERE VendorId = @vendorId ORDER BY Material
  `);
  return recordset;
}

// ── Deliveries (GR lines) ────────────────────────────────────────────────────

const DELIVERY_COLUMNS = `
  d.DeliveryId, d.VendorId, d.Material, d.MaterialDocument, d.MaterialDocItem,
  d.Quantity, d.Uom, d.Container, d.BillOfLading, d.InvoiceNumber,
  d.DocumentDate, d.PostingDate, d.RemainingQty, d.Source, d.CreatedAtUtc, d.CreatedByUsername,
  -- ExpiryDate is calculated, not SAP-sourced (SAP has no reliable expiry
  -- field for this material at GR time) — a manual entry on the delivery
  -- line (d.ExpiryDate) always wins when present; otherwise it's derived
  -- from the vendor's own policy window (ConsignmentVendorConfig.ExpiryDays
  -- calendar days after DocumentDate). NULL either way if neither is set —
  -- same "no expiry known" behaviour as before this existed. See
  -- migrate_consignment_expiry_days.sql for the full rationale.
  ISNULL(d.ExpiryDate,
         CASE WHEN cvc.ExpiryDays IS NOT NULL AND d.DocumentDate IS NOT NULL
              THEN DATEADD(day, cvc.ExpiryDays, d.DocumentDate) END) AS ExpiryDate
`;

export async function listConsignmentDeliveries(vendorId, material) {
  const pool = await getPool();
  const req = pool.request().input('vendorId', sql.Int, vendorId);
  let where = 'WHERE d.VendorId = @vendorId';
  if (material) { req.input('material', sql.NVarChar(18), material); where += ' AND d.Material = @material'; }
  const { recordset } = await req.query(`
    SELECT ${DELIVERY_COLUMNS}
    FROM dbo.ConsignmentDelivery d
    LEFT JOIN dbo.ConsignmentVendorConfig cvc ON cvc.VendorId = d.VendorId
    ${where}
    ORDER BY d.Material, COALESCE(d.ExpiryDate,
                                   CASE WHEN cvc.ExpiryDays IS NOT NULL AND d.DocumentDate IS NOT NULL
                                        THEN DATEADD(day, cvc.ExpiryDays, d.DocumentDate) END,
                                   '9999-12-31'),
             d.DocumentDate
  `);
  return recordset;
}

// SAP-sync upsert: insert-if-missing by (MaterialDocument, MaterialDocItem),
// same "staging + INSERT...WHERE NOT EXISTS" idiom already used elsewhere in
// this codebase (performancesql.js's insertDeliveryOrderLinksIfMissing) so a
// re-run of the daily sync never creates duplicates or disturbs an existing
// row's RemainingQty (which may have already been partly declared).
export async function upsertConsignmentDeliveriesFromSap(vendorId, rows) {
  if (!rows.length) return { inserted: 0 };
  const pool = await getPool();

  const seen = new Set();
  const deduped = rows.filter(r => {
    const key = `${r.materialDocument}||${r.materialDocItem}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let inserted = 0;
  const batchSize = 200;
  for (let i = 0; i < deduped.length; i += batchSize) {
    const batch = deduped.slice(i, i + batchSize);
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      for (const r of batch) {
        const req = tx.request()
          .input('vendorId', sql.Int, vendorId)
          .input('material', sql.NVarChar(18), r.material)
          .input('materialDocument', sql.NVarChar(10), r.materialDocument)
          .input('materialDocItem', sql.NVarChar(4), r.materialDocItem)
          .input('quantity', sql.Decimal(15, 3), r.quantity)
          .input('uom', sql.NVarChar(3), r.uom || null)
          .input('invoiceNumber', sql.NVarChar(30), r.invoiceNumber || null)
          .input('documentDate', sql.DateTime, r.documentDate || null)
          .input('postingDate', sql.DateTime, r.postingDate || null);

        const result = await req.query(`
          INSERT INTO dbo.ConsignmentDelivery
            (VendorId, Material, MaterialDocument, MaterialDocItem, Quantity, Uom,
             InvoiceNumber, DocumentDate, PostingDate, RemainingQty, Source)
          SELECT @vendorId, @material, @materialDocument, @materialDocItem, @quantity, @uom,
                 @invoiceNumber, @documentDate, @postingDate, @quantity, 'SAP'
          WHERE NOT EXISTS (
            SELECT 1 FROM dbo.ConsignmentDelivery
            WHERE MaterialDocument = @materialDocument AND MaterialDocItem = @materialDocItem
          )
        `);
        inserted += result.rowsAffected[0] || 0;
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }
  return { inserted };
}

export async function addManualConsignmentDelivery(vendorId, body, username) {
  const pool = await getPool();
  const result = await pool.request()
    .input('vendorId', sql.Int, vendorId)
    .input('material', sql.NVarChar(18), body.material)
    .input('materialDocument', sql.NVarChar(10), body.materialDocument || `MANUAL-${Date.now()}`)
    .input('materialDocItem', sql.NVarChar(4), body.materialDocItem || '0001')
    .input('quantity', sql.Decimal(15, 3), body.quantity)
    .input('uom', sql.NVarChar(3), body.uom || null)
    .input('container', sql.NVarChar(20), body.container || null)
    .input('billOfLading', sql.NVarChar(30), body.billOfLading || null)
    .input('invoiceNumber', sql.NVarChar(30), body.invoiceNumber || null)
    .input('documentDate', sql.DateTime, body.documentDate || null)
    .input('postingDate', sql.DateTime, body.postingDate || null)
    .input('expiryDate', sql.DateTime, body.expiryDate || null)
    .input('source', sql.NVarChar(10), body.source === 'CSV' ? 'CSV' : 'MANUAL')
    .input('username', sql.NVarChar(80), username || null)
    .query(`
      INSERT INTO dbo.ConsignmentDelivery
        (VendorId, Material, MaterialDocument, MaterialDocItem, Quantity, Uom,
         Container, BillOfLading, InvoiceNumber, DocumentDate, PostingDate, ExpiryDate,
         RemainingQty, Source, CreatedByUsername)
      OUTPUT INSERTED.DeliveryId
      VALUES
        (@vendorId, @material, @materialDocument, @materialDocItem, @quantity, @uom,
         @container, @billOfLading, @invoiceNumber, @documentDate, @postingDate, @expiryDate,
         @quantity, @source, @username)
    `);
  return result.recordset[0].DeliveryId;
}

export async function updateConsignmentDelivery(deliveryId, body) {
  const pool = await getPool();
  await pool.request()
    .input('deliveryId', sql.Int, deliveryId)
    .input('invoiceNumber', sql.NVarChar(30), body.invoiceNumber ?? null)
    .input('container', sql.NVarChar(20), body.container ?? null)
    .input('billOfLading', sql.NVarChar(30), body.billOfLading ?? null)
    .input('expiryDate', sql.DateTime, body.expiryDate ?? null)
    .query(`
      UPDATE dbo.ConsignmentDelivery SET
        InvoiceNumber = @invoiceNumber, Container = @container,
        BillOfLading = @billOfLading, ExpiryDate = @expiryDate
      WHERE DeliveryId = @deliveryId
    `);
}

// ── Stock snapshot cache (SAP MKOL SLABS, plant-wide) ────────────────────────
//
// Overwrite-only cache (TRUNCATE + re-insert every run), same convention as
// dbo.TurnsValClassSnapshot — refreshed daily by the 06:20 cron (see
// routes/consignment.js's runConsignmentSync/refreshConsignmentStockSnapshot)
// plus an optional manual "Refresh Now". See
// sql/migrate_consignment_stock_snapshot.sql for the full rationale: this
// exists so the balance dashboard is an instant SQL read instead of a live
// SAP call that could legitimately take minutes (the unfiltered plant-wide
// MKOL scan — see BuildConsignmentStockRequest in SapServer).
export async function replaceConsignmentStockSnapshot(stockByMaterial) {
  const pool = await getPool();
  const entries = Object.entries(stockByMaterial || {});
  const syncedAt = new Date();

  await pool.request().query('TRUNCATE TABLE dbo.ConsignmentStockSnapshot');
  if (!entries.length) return { materialCount: 0, syncedAtUtc: syncedAt };

  const batchSize = 600; // 3 params/row — comfortably under SQL Server's 2100-param limit
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const request = pool.request();
    const selectClauses = [];
    batch.forEach(([material, qty], idx) => {
      request.input(`m${idx}`, sql.NVarChar(18), material);
      request.input(`q${idx}`, sql.Decimal(15, 3), Number(qty) || 0);
      request.input(`t${idx}`, sql.DateTime, syncedAt);
      selectClauses.push(`SELECT @m${idx} AS Material, @q${idx} AS Qty, @t${idx} AS SnapshotAtUtc`);
    });
    await request.query(`
      INSERT INTO dbo.ConsignmentStockSnapshot (Material, Qty, SnapshotAtUtc)
      ${selectClauses.join('\nUNION ALL\n')}
    `);
  }
  return { materialCount: entries.length, syncedAtUtc: syncedAt };
}

export async function getConsignmentStockSnapshot() {
  const pool = await getPool();
  const { recordset } = await pool.request().query('SELECT Material, Qty FROM dbo.ConsignmentStockSnapshot');
  const byMaterial = {};
  for (const row of recordset) byMaterial[row.Material] = Number(row.Qty);
  return byMaterial;
}

export async function getConsignmentStockSnapshotMeta() {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT COUNT(*) AS MaterialCount, MAX(SnapshotAtUtc) AS LastSnapshotAtUtc
    FROM dbo.ConsignmentStockSnapshot
  `);
  const row = recordset[0] || {};
  return { materialCount: row.MaterialCount || 0, lastSnapshotAtUtc: row.LastSnapshotAtUtc || null };
}

// ── Balance calc ("undeclared consumption") ─────────────────────────────────
//
// See migrate_consignment_tracker.sql's header for why this is a balance
// (Delivered - live SAP stock - already Declared) rather than a raw SAP
// consumption-movement pull. Returns { [material]: { delivered, declared } }
// — the caller (routes/consignment.js) combines this with the cached SAP
// stock snapshot to get `undeclared = delivered - stock - declared` per
// material.
export async function getVendorDeliveredAndDeclaredTotals(vendorId) {
  const pool = await getPool();
  const { recordset } = await pool.request().input('vendorId', sql.Int, vendorId).query(`
    SELECT
      d.Material,
      SUM(d.Quantity) AS Delivered,
      ISNULL((
        SELECT SUM(dl.QtyAllocated)
        FROM dbo.ConsignmentDeclarationLine dl
        JOIN dbo.ConsignmentDeclaration dec ON dec.DeclarationId = dl.DeclarationId
        WHERE dec.Status = 'Confirmed' AND dl.Material = d.Material AND dec.VendorId = @vendorId
      ), 0) AS Declared
    FROM dbo.ConsignmentDelivery d
    WHERE d.VendorId = @vendorId
    GROUP BY d.Material
  `);
  return recordset;
}

// ── Declarations ──────────────────────────────────────────────────────────────

export async function createDeclaration(vendorId, allocationMethod, lines, username) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const totalQty = lines.reduce((s, l) => s + Number(l.qtyAllocated), 0);

    const header = await tx.request()
      .input('vendorId', sql.Int, vendorId)
      .input('allocationMethod', sql.NVarChar(10), allocationMethod || 'MANUAL')
      .input('totalQty', sql.Decimal(15, 3), totalQty)
      .input('username', sql.NVarChar(80), username || null)
      .query(`
        INSERT INTO dbo.ConsignmentDeclaration (VendorId, Status, AllocationMethod, TotalQty, CreatedByUsername)
        OUTPUT INSERTED.DeclarationId
        VALUES (@vendorId, 'Draft', @allocationMethod, @totalQty, @username)
      `);
    const declarationId = header.recordset[0].DeclarationId;

    for (const line of lines) {
      await tx.request()
        .input('declarationId', sql.Int, declarationId)
        .input('deliveryId', sql.Int, line.deliveryId)
        .input('material', sql.NVarChar(18), line.material)
        .input('qtyAllocated', sql.Decimal(15, 3), line.qtyAllocated)
        .query(`
          INSERT INTO dbo.ConsignmentDeclarationLine (DeclarationId, DeliveryId, Material, QtyAllocated)
          VALUES (@declarationId, @deliveryId, @material, @qtyAllocated)
        `);
    }

    await tx.commit();
    return declarationId;
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

// Replaces every line on a still-Draft declaration — backs the editable
// matrix preview (adjust FEFO proposal by hand before confirming).
export async function setDeclarationLines(declarationId, lines) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const statusCheck = await tx.request().input('declarationId', sql.Int, declarationId)
      .query('SELECT Status FROM dbo.ConsignmentDeclaration WHERE DeclarationId = @declarationId');
    if (!statusCheck.recordset.length) throw new Error('Declaration not found.');
    if (statusCheck.recordset[0].Status !== 'Draft') throw new Error('Only a Draft declaration can have its lines edited.');

    await tx.request().input('declarationId', sql.Int, declarationId)
      .query('DELETE FROM dbo.ConsignmentDeclarationLine WHERE DeclarationId = @declarationId');

    const totalQty = lines.reduce((s, l) => s + Number(l.qtyAllocated), 0);

    for (const line of lines) {
      await tx.request()
        .input('declarationId', sql.Int, declarationId)
        .input('deliveryId', sql.Int, line.deliveryId)
        .input('material', sql.NVarChar(18), line.material)
        .input('qtyAllocated', sql.Decimal(15, 3), line.qtyAllocated)
        .query(`
          INSERT INTO dbo.ConsignmentDeclarationLine (DeclarationId, DeliveryId, Material, QtyAllocated)
          VALUES (@declarationId, @deliveryId, @material, @qtyAllocated)
        `);
    }

    await tx.request().input('declarationId', sql.Int, declarationId).input('totalQty', sql.Decimal(15, 3), totalQty)
      .query('UPDATE dbo.ConsignmentDeclaration SET TotalQty = @totalQty WHERE DeclarationId = @declarationId');

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

export async function getDeclaration(declarationId) {
  const pool = await getPool();
  const headerRes = await pool.request().input('declarationId', sql.Int, declarationId).query(`
    SELECT dec.DeclarationId, dec.VendorId, v.VendorName, dec.Status, dec.AllocationMethod, dec.TotalQty,
           dec.CreatedAtUtc, dec.CreatedByUsername, dec.ConfirmedAtUtc, dec.ConfirmedByUsername,
           dec.SettlementDocumentNumber, dec.SettlementReconciledQty, dec.Notes
    FROM dbo.ConsignmentDeclaration dec
    JOIN dbo.Vendor v ON v.VendorId = dec.VendorId
    WHERE dec.DeclarationId = @declarationId
  `);
  if (!headerRes.recordset.length) return null;

  // ExpiryDate here is the same calculated-fallback expression as
  // listConsignmentDeliveries (manual override wins, else DocumentDate +
  // vendor's ExpiryDays) — see that function's comment. Computed fresh on
  // every read rather than snapshotted at declaration-creation time, so a
  // later correction to a vendor's ExpiryDays config is reflected on a
  // still-open Draft declaration too.
  const linesRes = await pool.request().input('declarationId', sql.Int, declarationId).query(`
    SELECT dl.DeclarationLineId, dl.DeliveryId, dl.Material, dl.QtyAllocated,
           d.InvoiceNumber, d.MaterialDocument, d.DocumentDate, d.Uom,
           ISNULL(d.ExpiryDate,
                  CASE WHEN cvc.ExpiryDays IS NOT NULL AND d.DocumentDate IS NOT NULL
                       THEN DATEADD(day, cvc.ExpiryDays, d.DocumentDate) END) AS ExpiryDate
    FROM dbo.ConsignmentDeclarationLine dl
    JOIN dbo.ConsignmentDelivery d ON d.DeliveryId = dl.DeliveryId
    LEFT JOIN dbo.ConsignmentVendorConfig cvc ON cvc.VendorId = d.VendorId
    WHERE dl.DeclarationId = @declarationId
    ORDER BY dl.Material, COALESCE(d.ExpiryDate,
                                    CASE WHEN cvc.ExpiryDays IS NOT NULL AND d.DocumentDate IS NOT NULL
                                         THEN DATEADD(day, cvc.ExpiryDays, d.DocumentDate) END,
                                    '9999-12-31')
  `);

  return { ...headerRes.recordset[0], lines: linesRes.recordset };
}

export async function listDeclarations(vendorId) {
  const pool = await getPool();
  const req = pool.request();
  let where = '';
  if (vendorId) { req.input('vendorId', sql.Int, vendorId); where = 'WHERE dec.VendorId = @vendorId'; }
  const { recordset } = await req.query(`
    SELECT dec.DeclarationId, dec.VendorId, v.VendorName, dec.Status, dec.AllocationMethod, dec.TotalQty,
           dec.CreatedAtUtc, dec.CreatedByUsername, dec.ConfirmedAtUtc, dec.ConfirmedByUsername,
           dec.SettlementDocumentNumber, dec.SettlementReconciledQty
    FROM dbo.ConsignmentDeclaration dec
    JOIN dbo.Vendor v ON v.VendorId = dec.VendorId
    ${where}
    ORDER BY dec.CreatedAtUtc DESC
  `);
  return recordset;
}

// Confirms a Draft declaration and decrements RemainingQty on every delivery
// line it allocates against — this is the "commit" moment the
// VENDOR_CONSIGNMENT permission gates (see routes/consignment.js), matching
// the "elevated user permission to call MRKO" requirement. MRKO itself has
// already been run by the user in SAP GUI by this point (see the SQL
// migration header for why that stays manual) — settlementDocumentNumber is
// what they paste back from it.
export async function confirmDeclaration(declarationId, settlementDocumentNumber, settlementReconciledQty, username) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const statusCheck = await tx.request().input('declarationId', sql.Int, declarationId)
      .query('SELECT Status FROM dbo.ConsignmentDeclaration WHERE DeclarationId = @declarationId');
    if (!statusCheck.recordset.length) throw new Error('Declaration not found.');
    if (statusCheck.recordset[0].Status !== 'Draft') throw new Error(`Declaration is already ${statusCheck.recordset[0].Status}, not Draft.`);

    const lines = await tx.request().input('declarationId', sql.Int, declarationId)
      .query('SELECT DeliveryId, QtyAllocated FROM dbo.ConsignmentDeclarationLine WHERE DeclarationId = @declarationId');

    for (const line of lines.recordset) {
      const upd = await tx.request()
        .input('deliveryId', sql.Int, line.DeliveryId)
        .input('qty', sql.Decimal(15, 3), line.QtyAllocated)
        .query(`
          UPDATE dbo.ConsignmentDelivery SET RemainingQty = RemainingQty - @qty
          WHERE DeliveryId = @deliveryId AND RemainingQty >= @qty
        `);
      if (!upd.rowsAffected[0]) {
        throw new Error(`Delivery line ${line.DeliveryId} no longer has enough remaining balance — someone else may have declared against it since this draft was built. Rebuild the declaration and try again.`);
      }
    }

    await tx.request()
      .input('declarationId', sql.Int, declarationId)
      .input('settlementDocumentNumber', sql.NVarChar(10), settlementDocumentNumber || null)
      .input('settlementReconciledQty', sql.Decimal(15, 3), settlementReconciledQty ?? null)
      .input('username', sql.NVarChar(80), username || null)
      .query(`
        UPDATE dbo.ConsignmentDeclaration SET
          Status = 'Confirmed', ConfirmedAtUtc = GETUTCDATE(), ConfirmedByUsername = @username,
          SettlementDocumentNumber = @settlementDocumentNumber, SettlementReconciledQty = @settlementReconciledQty
        WHERE DeclarationId = @declarationId
      `);

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
  return getDeclaration(declarationId);
}

export async function cancelDeclaration(declarationId) {
  const pool = await getPool();
  const result = await pool.request().input('declarationId', sql.Int, declarationId).query(`
    UPDATE dbo.ConsignmentDeclaration SET Status = 'Cancelled'
    WHERE DeclarationId = @declarationId AND Status = 'Draft'
  `);
  if (!result.rowsAffected[0]) throw new Error('Only a Draft declaration can be cancelled (Confirmed declarations already adjusted delivery balances).');
}

// ── FEFO/FIFO allocation proposal (pure function, no DB) ────────────────────
//
// Greedily walks open delivery lines (RemainingQty > 0) for one material,
// ordered by the caller per allocationMethod (FEFO = ExpiryDate ascending,
// FIFO = DocumentDate ascending — see listConsignmentDeliveries' ORDER BY,
// which already sorts FEFO-first; callers wanting FIFO re-sort by
// DocumentDate before calling this), consuming qtyToDeclare across them.
// Mirrors exactly what Raaj's Summary tab records after the fact — this is
// the same allocation, proposed before MRKO runs instead of read back
// afterward.
export function buildAllocationProposal(deliveryRows, qtyToDeclare) {
  const lines = [];
  let remaining = Number(qtyToDeclare);

  for (const row of deliveryRows) {
    if (remaining <= 0) break;
    const available = Number(row.RemainingQty);
    if (available <= 0) continue;

    const take = Math.min(available, remaining);
    lines.push({
      deliveryId: row.DeliveryId,
      material: row.Material,
      qtyAllocated: Math.round(take * 1000) / 1000,
      invoiceNumber: row.InvoiceNumber,
      expiryDate: row.ExpiryDate,
      documentDate: row.DocumentDate,
      remainingBeforeAllocation: available,
    });
    remaining -= take;
  }

  return { lines, unallocatedQty: Math.round(remaining * 1000) / 1000 };
}
