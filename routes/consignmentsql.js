// routes/consignmentsql.js
//
// DB layer for the Vendor Consignment Tracker (Logistics > Material
// Planning). See sql/migrate_consignment_tracker.sql for the full schema +
// design writeup — especially the "UNDECLARED CONSUMPTION IS A BALANCE"
// section, which this file's getVendorBalance() implements directly.
//
// Reuses log.Vendor/log.VendorMaterial (already seeded from MRP2.xlsx —
// Chemours, Fothergill/FCF, Raaj all already exist there) rather than a
// separate vendor table — a vendor consignment-tracks the exact same
// materials it's already an MRP source for. DATETIME (not DATE) throughout,
// matching every other date column in this project.

import sql from 'mssql';
import { getNexusOperationsPool } from '../config.js';

const getPool = getNexusOperationsPool;

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
    FROM log.ConsignmentVendorConfig cvc
    JOIN log.Vendor v ON v.VendorId = cvc.VendorId
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
      FROM log.Vendor v
      LEFT JOIN log.ConsignmentVendorConfig cvc ON cvc.VendorId = v.VendorId
      WHERE v.VendorId = @vendorId
    `);
  return recordset[0] || null;
}

// Guarded upsert — log.ConsignmentVendorConfig.VendorId is the PK, so this is
// a plain existence-check-then-INSERT-or-UPDATE (no MERGE — SQL2005).
export async function upsertConsignmentVendorConfig(vendorId, body, username) {
  const pool = await getPool();
  const exists = await pool.request().input('vendorId', sql.Int, vendorId)
    .query('SELECT 1 FROM log.ConsignmentVendorConfig WHERE VendorId = @vendorId');

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
      UPDATE log.ConsignmentVendorConfig SET
        TrackExpiry = @trackExpiry, ExpiryWarningDays = @expiryWarningDays,
        ExpiryDays = @expiryDays,
        DefaultAllocationMethod = @defaultAllocationMethod, Active = @active,
        Notes = @notes, UpdatedAtUtc = GETUTCDATE(), UpdatedByUsername = @username
      WHERE VendorId = @vendorId
    `);
  } else {
    await req.query(`
      INSERT INTO log.ConsignmentVendorConfig
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
    FROM log.VendorMaterial WHERE VendorId = @vendorId ORDER BY Material
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
  -- calendar days after PostingDate — MKPF-BUDAT, the date the goods
  -- receipt actually posted to stock, not BLDAT/DocumentDate which is just
  -- the date printed on the supplier's paperwork and can lag or lead the
  -- real posting by a day or more. NULL either way if neither is set —
  -- same "no expiry known" behaviour as before this existed. See
  -- migrate_consignment_expiry_days.sql for the full rationale.
  ISNULL(d.ExpiryDate,
         CASE WHEN cvc.ExpiryDays IS NOT NULL AND d.PostingDate IS NOT NULL
              THEN DATEADD(day, cvc.ExpiryDays, d.PostingDate) END) AS ExpiryDate
`;

export async function listConsignmentDeliveries(vendorId, material) {
  const pool = await getPool();
  const req = pool.request().input('vendorId', sql.Int, vendorId);
  let where = 'WHERE d.VendorId = @vendorId';
  if (material) { req.input('material', sql.NVarChar(18), material); where += ' AND d.Material = @material'; }
  const { recordset } = await req.query(`
    SELECT ${DELIVERY_COLUMNS}
    FROM log.ConsignmentDelivery d
    LEFT JOIN log.ConsignmentVendorConfig cvc ON cvc.VendorId = d.VendorId
    ${where}
    ORDER BY d.Material, COALESCE(d.ExpiryDate,
                                   CASE WHEN cvc.ExpiryDays IS NOT NULL AND d.PostingDate IS NOT NULL
                                        THEN DATEADD(day, cvc.ExpiryDays, d.PostingDate) END,
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
//
// Also backfills InvoiceNumber/ReversalOfMaterialDocument/
// ReversalOfMaterialDocItem onto an ALREADY-EXISTING row whenever the fresh
// SAP pull has a value the stored row is still missing (COALESCE-guarded —
// never overwrites a non-blank stored value, only fills a gap). Both the
// daily cron and the manual /sync route always re-pull FULL vendor history
// (no sinceDate floor — see fetchSapVendorGr's call sites), so this is what
// lets a field that used to come back blank from SapServer (invoice number
// before the 2026-07-31 XBLNR_MKPF fix; SMBLN/SMBLP before this reversal-
// tracking change) get filled in retroactively on the next ordinary sync,
// without a separate one-off backfill script.
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
          .input('postingDate', sql.DateTime, r.postingDate || null)
          .input('reversalOfMaterialDocument', sql.NVarChar(10), r.reversalOfMaterialDocument || null)
          .input('reversalOfMaterialDocItem', sql.NVarChar(4), r.reversalOfMaterialDocItem || null);

        const result = await req.query(`
          INSERT INTO log.ConsignmentDelivery
            (VendorId, Material, MaterialDocument, MaterialDocItem, Quantity, Uom,
             InvoiceNumber, DocumentDate, PostingDate, RemainingQty, Source,
             ReversalOfMaterialDocument, ReversalOfMaterialDocItem)
          SELECT @vendorId, @material, @materialDocument, @materialDocItem, @quantity, @uom,
                 @invoiceNumber, @documentDate, @postingDate, @quantity, 'SAP',
                 @reversalOfMaterialDocument, @reversalOfMaterialDocItem
          WHERE NOT EXISTS (
            SELECT 1 FROM log.ConsignmentDelivery
            WHERE MaterialDocument = @materialDocument AND MaterialDocItem = @materialDocItem
          )
        `);
        inserted += result.rowsAffected[0] || 0;

        await req.query(`
          UPDATE log.ConsignmentDelivery SET
            InvoiceNumber = COALESCE(NULLIF(InvoiceNumber, ''), @invoiceNumber),
            ReversalOfMaterialDocument = COALESCE(ReversalOfMaterialDocument, @reversalOfMaterialDocument),
            ReversalOfMaterialDocItem = COALESCE(ReversalOfMaterialDocItem, @reversalOfMaterialDocItem)
          WHERE MaterialDocument = @materialDocument AND MaterialDocItem = @materialDocItem
            AND (
              (InvoiceNumber IS NULL OR InvoiceNumber = '') AND @invoiceNumber IS NOT NULL
              OR (ReversalOfMaterialDocument IS NULL AND @reversalOfMaterialDocument IS NOT NULL)
            )
        `);
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }
  return { inserted };
}

// ── Reversal-chain cancellation ──────────────────────────────────────────────
//
// A goods receipt line cancelled in SAP (transaction MBST) doesn't disappear
// — it gets a second MSEG line (same BWART=101 family, opposite SHKZG sign
// via a 102, or — confirmed for real against this plant's Raaj Ratna data —
// sometimes a further "cancel-of-a-cancel" back to BWART=101/positive) whose
// SMBLN/SMBLP point back at the document+item it reverses. The aggregate
// Delivered/Undeclared balance (getVendorDeliveredAndDeclaredTotals) already
// nets these correctly since it just sums signed Quantity — but RemainingQty
// is tracked per delivery LINE, and nothing ever zeroed it out for a
// cancelled line (only a Nexus-confirmed declaration decrements it). A
// cancelled line's full original quantity therefore sat there forever,
// eventually aging past ExpiryDays and firing a false "overdue" warning for
// material that was never physically outstanding — confirmed for real: Raaj
// Ratna doc 5005206623 (cancelled same-day by 5005206624/MBST) and the chain
// 5005174284 → 5005203102 (cancels it) → 5005203103 (cancels THAT
// cancellation, MBST) were both showing as overdue.
//
// computeReversalCancellations is the pure parity-walk: build each
// cancellation chain via ReversalOfMaterialDocument/Item (root = a row
// nothing else's SMBLN can walk past, i.e. its own reversal target is blank
// or not present in this row set), walk forward from the root assigning
// alternating live/cancelled state (root starts live), and the chain's FINAL
// state at its last link determines whether the ROOT ends up live or
// cancelled — an even total chain length (root + odd number of reversals)
// cancels the root; odd length (root + even number of reversals) restores
// it. Every non-root row in a chain is always cancelled regardless of parity
// — it only ever existed as a paperwork correction, never independent stock
// (and forcing the ROOT, not whichever row is chain-final, to carry the
// live RemainingQty keeps ExpiryDate calculations anchored to the true
// original PostingDate, not a later correction's date).
//
// A row is only ever actually zeroed if RemainingQty still exactly equals
// its own Quantity (i.e. nothing has genuinely declared against it yet) —
// a row a real Nexus declaration already touched is left alone and reported
// in needsReview instead of silently overwritten, since that declaration is
// a real settlement event this function has no business contradicting.
export function computeReversalCancellations(rows) {
  const byKey = new Map();
  for (const r of rows) byKey.set(`${r.MaterialDocument}|${r.MaterialDocItem}`, r);

  // reverseLookup: target key -> the row(s) whose SMBLN/SMBLP point at it.
  const reverseLookup = new Map();
  for (const r of rows) {
    if (!r.ReversalOfMaterialDocument) continue;
    const targetKey = `${r.ReversalOfMaterialDocument}|${r.ReversalOfMaterialDocItem}`;
    if (!byKey.has(targetKey)) continue; // reverses something outside this row set — can't chain past it
    if (!reverseLookup.has(targetKey)) reverseLookup.set(targetKey, []);
    reverseLookup.get(targetKey).push(r);
  }

  const toZero = [];
  const needsReview = [];
  const visited = new Set();

  const isRoot = (r) => {
    if (!r.ReversalOfMaterialDocument) return true;
    return !byKey.has(`${r.ReversalOfMaterialDocument}|${r.ReversalOfMaterialDocItem}`);
  };

  for (const root of rows) {
    const rootKey = `${root.MaterialDocument}|${root.MaterialDocItem}`;
    if (visited.has(rootKey) || !isRoot(root)) continue;

    // Walk forward from the root. Anomaly guard: if more than one row
    // reverses the same document, only the first (deterministic input
    // order) is followed — the rest are reported, not silently dropped.
    const chain = [root];
    visited.add(rootKey);
    let current = root;
    for (let hops = 0; hops < rows.length; hops++) {
      const key = `${current.MaterialDocument}|${current.MaterialDocItem}`;
      const reversers = reverseLookup.get(key) || [];
      if (!reversers.length) break;
      const [next, ...extra] = reversers;
      for (const e of extra) needsReview.push({ row: e, reason: 'multiple documents reverse the same target' });
      const nextKey = `${next.MaterialDocument}|${next.MaterialDocItem}`;
      if (visited.has(nextKey)) break; // cycle guard — shouldn't happen with real SAP data
      visited.add(nextKey);
      chain.push(next);
      current = next;
    }

    if (chain.length === 1) continue; // standalone row, nothing to cancel

    const rootLive = chain.length % 2 === 1;
    for (let i = 0; i < chain.length; i++) {
      const isLiveRow = i === 0 && rootLive;
      if (isLiveRow) continue;
      const row = chain[i];
      const untouched = Math.abs(Number(row.RemainingQty) - Number(row.Quantity)) < 0.001;
      if (untouched) toZero.push(row);
      else needsReview.push({ row, reason: 'reversal-chain says cancelled, but RemainingQty already differs from Quantity (a declaration was made against it)' });
    }
  }

  return { toZero, needsReview };
}

// Applies computeReversalCancellations for one vendor's current delivery
// rows, zeroing RemainingQty for every row it says is safe to zero. Safe to
// re-run any time (idempotent — an already-zeroed row's RemainingQty simply
// equals its target already, and setDeclarationLines'/confirmDeclaration's
// direct decrements are untouched). Called after every sync (see
// routes/consignment.js) and available to run standalone for a retroactive
// correction over already-synced history.
export async function applyReversalCancellations(vendorId) {
  const pool = await getPool();
  const { recordset } = await pool.request().input('vendorId', sql.Int, vendorId).query(`
    SELECT DeliveryId, Material, MaterialDocument, MaterialDocItem, Quantity, RemainingQty,
           ReversalOfMaterialDocument, ReversalOfMaterialDocItem
    FROM log.ConsignmentDelivery WHERE VendorId = @vendorId
  `);

  const { toZero, needsReview } = computeReversalCancellations(recordset);

  for (const row of toZero) {
    await pool.request()
      .input('deliveryId', sql.Int, row.DeliveryId)
      .query('UPDATE log.ConsignmentDelivery SET RemainingQty = 0 WHERE DeliveryId = @deliveryId');
  }

  return {
    zeroed: toZero.map(r => ({ deliveryId: r.DeliveryId, material: r.Material, materialDocument: r.MaterialDocument, materialDocItem: r.MaterialDocItem, quantity: Number(r.Quantity) })),
    needsReview: needsReview.map(n => ({
      deliveryId: n.row.DeliveryId, material: n.row.Material, materialDocument: n.row.MaterialDocument,
      materialDocItem: n.row.MaterialDocItem, quantity: Number(n.row.Quantity), remainingQty: Number(n.row.RemainingQty),
      reason: n.reason,
    })),
  };
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
      INSERT INTO log.ConsignmentDelivery
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
      UPDATE log.ConsignmentDelivery SET
        InvoiceNumber = @invoiceNumber, Container = @container,
        BillOfLading = @billOfLading, ExpiryDate = @expiryDate
      WHERE DeliveryId = @deliveryId
    `);
}

// ── Stock snapshot cache (SAP MKOL SLABS, plant-wide) ────────────────────────
//
// Overwrite-only cache (TRUNCATE + re-insert every run), same convention as
// log.TurnsValClassSnapshot — refreshed daily by the 06:20 cron (see
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

  await pool.request().query('TRUNCATE TABLE log.ConsignmentStockSnapshot');
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
      INSERT INTO log.ConsignmentStockSnapshot (Material, Qty, SnapshotAtUtc)
      ${selectClauses.join('\nUNION ALL\n')}
    `);
  }
  return { materialCount: entries.length, syncedAtUtc: syncedAt };
}

export async function getConsignmentStockSnapshot() {
  const pool = await getPool();
  const { recordset } = await pool.request().query('SELECT Material, Qty FROM log.ConsignmentStockSnapshot');
  const byMaterial = {};
  for (const row of recordset) byMaterial[row.Material] = Number(row.Qty);
  return byMaterial;
}

export async function getConsignmentStockSnapshotMeta() {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT COUNT(*) AS MaterialCount, MAX(SnapshotAtUtc) AS LastSnapshotAtUtc
    FROM log.ConsignmentStockSnapshot
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
        FROM log.ConsignmentDeclarationLine dl
        JOIN log.ConsignmentDeclaration dec ON dec.DeclarationId = dl.DeclarationId
        WHERE dec.Status = 'Confirmed' AND dl.Material = d.Material AND dec.VendorId = @vendorId
      ), 0) AS Declared
    FROM log.ConsignmentDelivery d
    WHERE d.VendorId = @vendorId
    GROUP BY d.Material
  `);
  return recordset;
}

// Per-material Starting Stock / Deliveries / Ending Stock for ONE declaration's
// printable header — see lib/consignmentDeclarationPdf.js. Deliberately scoped
// "since the material's previous Confirmed declaration" (not all-time, and not
// the live SAP snapshot) so the figures read like a period statement — Opening
// + Deliveries − Consumption = Closing, the same shape as the old per-vendor
// workbooks (see migrate_consignment_tracker.sql's header) — without depending
// on daily stock-snapshot sync timing the way the dashboard's "Current Stock"
// column does.
//
// Starting Stock = Delivered(all-time) − Declared(Confirmed, all-time,
// excluding this declaration) — i.e. the book balance immediately before this
// declaration's own consumption. Ending Stock is computed by the caller as
// Starting Stock − this declaration's own qtyAllocated for that material
// (already known from the declaration's lines, so not re-derived here).
export async function getConsignmentDeclarationStockSummary(vendorId, declarationId, materials) {
  const pool = await getPool();
  const out = {};
  for (const material of materials) {
    const { recordset } = await pool.request()
      .input('vendorId', sql.Int, vendorId)
      .input('declarationId', sql.Int, declarationId)
      .input('material', sql.NVarChar(18), material)
      .query(`
        DECLARE @prevDeclDate DATETIME = (
          SELECT TOP 1 dec.CreatedAtUtc
          FROM log.ConsignmentDeclaration dec
          JOIN log.ConsignmentDeclarationLine dl ON dl.DeclarationId = dec.DeclarationId
          WHERE dec.VendorId = @vendorId AND dl.Material = @material
            AND dec.Status = 'Confirmed' AND dec.DeclarationId <> @declarationId
          ORDER BY dec.CreatedAtUtc DESC
        );

        SELECT
          ISNULL(SUM(d.Quantity), 0) AS DeliveredTotal,
          ISNULL(SUM(CASE WHEN @prevDeclDate IS NULL
                             OR ISNULL(d.PostingDate, ISNULL(d.DocumentDate, d.CreatedAtUtc)) > @prevDeclDate
                           THEN d.Quantity ELSE 0 END), 0) AS DeliveredSinceLastDecl,
          (SELECT ISNULL(SUM(dl2.QtyAllocated), 0)
           FROM log.ConsignmentDeclarationLine dl2
           JOIN log.ConsignmentDeclaration dec2 ON dec2.DeclarationId = dl2.DeclarationId
           WHERE dec2.Status = 'Confirmed' AND dl2.Material = @material AND dec2.VendorId = @vendorId
             AND dec2.DeclarationId <> @declarationId) AS DeclaredConfirmedExcludingThis
        FROM log.ConsignmentDelivery d
        WHERE d.VendorId = @vendorId AND d.Material = @material
      `);
    const row = recordset[0] || { DeliveredTotal: 0, DeliveredSinceLastDecl: 0, DeclaredConfirmedExcludingThis: 0 };
    const startingStock = Number(row.DeliveredTotal) - Number(row.DeclaredConfirmedExcludingThis);
    out[material] = { startingStock, deliveries: Number(row.DeliveredSinceLastDecl) };
  }
  return out;
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
        INSERT INTO log.ConsignmentDeclaration (VendorId, Status, AllocationMethod, TotalQty, CreatedByUsername)
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
          INSERT INTO log.ConsignmentDeclarationLine (DeclarationId, DeliveryId, Material, QtyAllocated)
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
      .query('SELECT Status FROM log.ConsignmentDeclaration WHERE DeclarationId = @declarationId');
    if (!statusCheck.recordset.length) throw new Error('Declaration not found.');
    if (statusCheck.recordset[0].Status !== 'Draft') throw new Error('Only a Draft declaration can have its lines edited.');

    await tx.request().input('declarationId', sql.Int, declarationId)
      .query('DELETE FROM log.ConsignmentDeclarationLine WHERE DeclarationId = @declarationId');

    const totalQty = lines.reduce((s, l) => s + Number(l.qtyAllocated), 0);

    for (const line of lines) {
      await tx.request()
        .input('declarationId', sql.Int, declarationId)
        .input('deliveryId', sql.Int, line.deliveryId)
        .input('material', sql.NVarChar(18), line.material)
        .input('qtyAllocated', sql.Decimal(15, 3), line.qtyAllocated)
        .query(`
          INSERT INTO log.ConsignmentDeclarationLine (DeclarationId, DeliveryId, Material, QtyAllocated)
          VALUES (@declarationId, @deliveryId, @material, @qtyAllocated)
        `);
    }

    await tx.request().input('declarationId', sql.Int, declarationId).input('totalQty', sql.Decimal(15, 3), totalQty)
      .query('UPDATE log.ConsignmentDeclaration SET TotalQty = @totalQty WHERE DeclarationId = @declarationId');

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
    FROM log.ConsignmentDeclaration dec
    JOIN log.Vendor v ON v.VendorId = dec.VendorId
    WHERE dec.DeclarationId = @declarationId
  `);
  if (!headerRes.recordset.length) return null;

  // ExpiryDate here is the same calculated-fallback expression as
  // listConsignmentDeliveries (manual override wins, else PostingDate —
  // BUDAT, not BLDAT/DocumentDate — plus vendor's ExpiryDays) — see that
  // function's comment. Computed fresh on
  // every read rather than snapshotted at declaration-creation time, so a
  // later correction to a vendor's ExpiryDays config is reflected on a
  // still-open Draft declaration too.
  const linesRes = await pool.request().input('declarationId', sql.Int, declarationId).query(`
    SELECT dl.DeclarationLineId, dl.DeliveryId, dl.Material, dl.QtyAllocated,
           d.InvoiceNumber, d.MaterialDocument, d.DocumentDate, d.Uom,
           ISNULL(d.ExpiryDate,
                  CASE WHEN cvc.ExpiryDays IS NOT NULL AND d.PostingDate IS NOT NULL
                       THEN DATEADD(day, cvc.ExpiryDays, d.PostingDate) END) AS ExpiryDate
    FROM log.ConsignmentDeclarationLine dl
    JOIN log.ConsignmentDelivery d ON d.DeliveryId = dl.DeliveryId
    LEFT JOIN log.ConsignmentVendorConfig cvc ON cvc.VendorId = d.VendorId
    WHERE dl.DeclarationId = @declarationId
    ORDER BY dl.Material, COALESCE(d.ExpiryDate,
                                    CASE WHEN cvc.ExpiryDays IS NOT NULL AND d.PostingDate IS NOT NULL
                                         THEN DATEADD(day, cvc.ExpiryDays, d.PostingDate) END,
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
    FROM log.ConsignmentDeclaration dec
    JOIN log.Vendor v ON v.VendorId = dec.VendorId
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
      .query('SELECT Status FROM log.ConsignmentDeclaration WHERE DeclarationId = @declarationId');
    if (!statusCheck.recordset.length) throw new Error('Declaration not found.');
    if (statusCheck.recordset[0].Status !== 'Draft') throw new Error(`Declaration is already ${statusCheck.recordset[0].Status}, not Draft.`);

    const lines = await tx.request().input('declarationId', sql.Int, declarationId)
      .query('SELECT DeliveryId, QtyAllocated FROM log.ConsignmentDeclarationLine WHERE DeclarationId = @declarationId');

    for (const line of lines.recordset) {
      const upd = await tx.request()
        .input('deliveryId', sql.Int, line.DeliveryId)
        .input('qty', sql.Decimal(15, 3), line.QtyAllocated)
        .query(`
          UPDATE log.ConsignmentDelivery SET RemainingQty = RemainingQty - @qty
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
        UPDATE log.ConsignmentDeclaration SET
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
    UPDATE log.ConsignmentDeclaration SET Status = 'Cancelled'
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

// ── Reassigning declarations off cancelled stock ────────────────────────────
//
// computeReversalCancellations only zeroes RemainingQty for a cancelled
// delivery line nobody has drawn against yet — a line a real (or, as
// discovered against this data, seed) declaration already fully declared
// against is left alone (see its own header comment) since silently
// zeroing it would contradict that declaration's own QtyAllocated. This is
// the follow-up correction for exactly those lines: find how much was
// declared against a now-known-cancelled delivery, and re-point that
// declaration line at the next real, still-open FEFO batch(es) instead —
// the aggregate Delivered/Undeclared balance is unaffected either way (it
// sums QtyAllocated per material, not per delivery line), but per-batch
// RemainingQty/expiry tracking is only accurate once the declared quantity
// is attributed to real stock instead of a document that turned out to have
// been reversed in SAP.
//
// Pure — reuses buildAllocationProposal's exact greedy walk per cancelled
// line, but (unlike a single proposal) has to share ONE mutable pool of
// open delivery rows across every cancelled line being reassigned in the
// same pass, so two cancelled lines for the same material don't both
// propose drawing from the same batch. cancelledLines are processed in
// (declarationId, declarationLineId) order for determinism.
export function computeReassignmentPlan(cancelledLines, openDeliveryRows) {
  const byMaterial = new Map();
  for (const row of openDeliveryRows) {
    const list = byMaterial.get(row.Material) || [];
    list.push({ ...row, RemainingQty: Number(row.RemainingQty) }); // local mutable copy
    byMaterial.set(row.Material, list);
  }
  for (const rows of byMaterial.values()) {
    rows.sort((a, b) => {
      const ea = a.ExpiryDate ? new Date(a.ExpiryDate).getTime() : Infinity;
      const eb = b.ExpiryDate ? new Date(b.ExpiryDate).getTime() : Infinity;
      if (ea !== eb) return ea - eb;
      const da = a.DocumentDate ? new Date(a.DocumentDate).getTime() : Infinity;
      const db = b.DocumentDate ? new Date(b.DocumentDate).getTime() : Infinity;
      return da - db;
    });
  }

  const ordered = [...cancelledLines].sort((a, b) =>
    a.declarationId - b.declarationId || a.declarationLineId - b.declarationLineId);

  return ordered.map(line => {
    const pool = byMaterial.get(line.material) || [];
    const { lines: splits, unallocatedQty } = buildAllocationProposal(pool, line.qtyAllocated);
    for (const s of splits) {
      const row = pool.find(r => r.DeliveryId === s.deliveryId);
      if (row) row.RemainingQty -= s.qtyAllocated;
    }
    return {
      declarationLineId: line.declarationLineId,
      declarationId: line.declarationId,
      material: line.material,
      cancelledDeliveryId: line.cancelledDeliveryId,
      totalQty: Math.round(Number(line.qtyAllocated) * 1000) / 1000,
      splits: splits.map(s => ({ deliveryId: s.deliveryId, qty: s.qtyAllocated })),
      shortfall: unallocatedQty,
    };
  });
}

// DB read half — gathers every declaration line currently pointing at a
// cancelled delivery for this vendor (via computeReversalCancellations'
// needsReview set, filtered to the positive-quantity side since a negative
// reversal row is never FEFO/FIFO-selectable in the first place) plus every
// currently-open real delivery line, and returns the resulting plan.
// Read-only — nothing is written until applyReassignmentPlan runs it.
export async function buildReassignmentPlanForVendor(vendorId) {
  const pool = await getPool();
  const { recordset: allRows } = await pool.request().input('vendorId', sql.Int, vendorId).query(`
    SELECT DeliveryId, Material, MaterialDocument, MaterialDocItem, Quantity, RemainingQty,
           ReversalOfMaterialDocument, ReversalOfMaterialDocItem
    FROM log.ConsignmentDelivery WHERE VendorId = @vendorId
  `);
  const { needsReview } = computeReversalCancellations(allRows);
  const cancelledDeliveryIds = needsReview.map(n => n.row).filter(r => Number(r.Quantity) > 0).map(r => r.DeliveryId);
  if (!cancelledDeliveryIds.length) return [];

  const req1 = pool.request();
  cancelledDeliveryIds.forEach((id, i) => req1.input(`id${i}`, sql.Int, id));
  const { recordset: lines } = await req1.query(`
    SELECT dl.DeclarationLineId, dl.DeclarationId, dl.DeliveryId AS CancelledDeliveryId, dl.Material, dl.QtyAllocated
    FROM log.ConsignmentDeclarationLine dl
    WHERE dl.DeliveryId IN (${cancelledDeliveryIds.map((_, i) => `@id${i}`).join(',')})
  `);
  if (!lines.length) return [];

  const cancelledLines = lines.map(l => ({
    declarationLineId: l.DeclarationLineId, declarationId: l.DeclarationId,
    cancelledDeliveryId: l.CancelledDeliveryId, material: l.Material, qtyAllocated: Number(l.QtyAllocated),
  }));

  // Same ExpiryDate fallback expression as listConsignmentDeliveries, so
  // FEFO ordering here matches what a real declaration proposal would use.
  const { recordset: openRows } = await pool.request().input('vendorId', sql.Int, vendorId).query(`
    SELECT d.DeliveryId, d.Material, d.RemainingQty,
           ISNULL(d.ExpiryDate,
                  CASE WHEN cvc.ExpiryDays IS NOT NULL AND d.PostingDate IS NOT NULL
                       THEN DATEADD(day, cvc.ExpiryDays, d.PostingDate) END) AS ExpiryDate,
           d.DocumentDate
    FROM log.ConsignmentDelivery d
    LEFT JOIN log.ConsignmentVendorConfig cvc ON cvc.VendorId = d.VendorId
    WHERE d.VendorId = @vendorId AND d.RemainingQty > 0
  `);

  return computeReassignmentPlan(cancelledLines, openRows);
}

// Applies an already-computed plan (from buildReassignmentPlanForVendor).
// Skips (does not write) any item with a shortfall — real open stock ran
// out before the declared quantity was fully covered — rather than
// partially reassigning it. A single-split item just re-points the
// existing ConsignmentDeclarationLine's DeliveryId; a multi-split item
// replaces it with one line per target so QtyAllocated still matches what
// each real batch actually absorbed. Every target delivery line's
// RemainingQty is decremented by what it absorbed, exactly as
// confirmDeclaration would have done had it been declared there originally.
export async function applyReassignmentPlan(plan) {
  const pool = await getPool();
  const applied = [];
  const skipped = [];

  for (const item of plan) {
    if (item.shortfall > 0.001) { skipped.push(item); continue; }

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      if (item.splits.length === 1) {
        await tx.request()
          .input('declarationLineId', sql.Int, item.declarationLineId)
          .input('deliveryId', sql.Int, item.splits[0].deliveryId)
          .query('UPDATE log.ConsignmentDeclarationLine SET DeliveryId = @deliveryId WHERE DeclarationLineId = @declarationLineId');
      } else {
        await tx.request().input('declarationLineId', sql.Int, item.declarationLineId)
          .query('DELETE FROM log.ConsignmentDeclarationLine WHERE DeclarationLineId = @declarationLineId');
        for (const split of item.splits) {
          await tx.request()
            .input('declarationId', sql.Int, item.declarationId)
            .input('deliveryId', sql.Int, split.deliveryId)
            .input('material', sql.NVarChar(18), item.material)
            .input('qtyAllocated', sql.Decimal(15, 3), split.qty)
            .query(`
              INSERT INTO log.ConsignmentDeclarationLine (DeclarationId, DeliveryId, Material, QtyAllocated)
              VALUES (@declarationId, @deliveryId, @material, @qtyAllocated)
            `);
        }
      }
      for (const split of item.splits) {
        await tx.request()
          .input('deliveryId', sql.Int, split.deliveryId)
          .input('qty', sql.Decimal(15, 3), split.qty)
          .query('UPDATE log.ConsignmentDelivery SET RemainingQty = RemainingQty - @qty WHERE DeliveryId = @deliveryId');
      }
      await tx.commit();
      applied.push(item);
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  return { applied, skipped };
}
