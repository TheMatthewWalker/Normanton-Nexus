// routes/consignment.js
//
// Vendor Consignment Tracker — Logistics > Material Planning. See
// sql/migrate_consignment_tracker.sql for the schema/design writeup and
// routes/consignmentsql.js for the DB layer (balance calc, FEFO/FIFO
// allocation proposal, declaration lifecycle).
//
// Own makeSapToken/sapAgent/audit boilerplate, same as staging.js/
// productionnexus.js/deliverymain.js/quality.js — each SAP-calling route
// file in this repo owns its own rather than sharing one across files.

import express from 'express';
import axios   from 'axios';
import https   from 'https';
import fs      from 'fs';
import jwt     from 'jsonwebtoken';
import sql     from 'mssql';
import { sapConfig, sapServerSecret, getNexusPool } from '../config.js';
import { requirePermission } from '../middleware/auth.js';
import * as db from './consignmentsql.js';
import { buildConsignmentDeclarationPdf } from '../lib/consignmentDeclarationPdf.js';

const router = express.Router();

// ── SAP caller ────────────────────────────────────────────────────────────────
const certPath = new URL('../certs/sap-server-cert.pem', import.meta.url);
const sapAgent = fs.existsSync(certPath)
  ? new https.Agent({ ca: fs.readFileSync(certPath), rejectUnauthorized: true })
  : null;

function makeSapToken() {
  return jwt.sign(
    { userId: 0 },
    sapServerSecret,
    { issuer: 'normanton-nexus', audience: 'sap-server', expiresIn: '60s' }
  );
}

async function audit(eventType, username, detail, req) {
  try {
    const pool = await getNexusPool();
    const ip = req?.ip || req?.socket?.remoteAddress || null;
    await pool.request()
      .input('username',  sql.NVarChar(80),  username || null)
      .input('eventType', sql.NVarChar(50),  eventType)
      .input('detail',    sql.NVarChar(500), detail || null)
      .input('ip',        sql.NVarChar(45),  ip)
      .query(`INSERT INTO dbo.PortalAuditLog (Username, EventType, Detail, IPAddress)
              VALUES (@username, @eventType, @detail, @ip)`);
  } catch (err) {
    console.error('[consignment audit]', err.message);
  }
}

function actor(req) {
  return req.session?.user?.username || 'unknown';
}

// Defensive against err not being a normal Error (or having an empty/
// undefined .message) — this used to surface as a literal "undefined" error
// in the UI (e.g. a SQL Server parameter-validation failure that doesn't set
// .message the way a plain Error does). Always guarantee a real string so
// the client's error banner has something useful to show.
function fail(res, err, status = 500) {
  const message = (err && err.message) ? err.message : 'Unexpected error — check server logs for details.';
  console.error('[consignment]', err);
  res.status(status).json({ success: false, error: { message } });
}

// Queries SapServer's GET /api/consignment/gr — see ConsignmentHelpers.cs.
// Filtering is LIFNR-based again (2026-07-30 rollback): SapServer briefly
// filtered MSEG on MATNR IN opt as a performance experiment, but that (and
// every other multi-value WHERE approach tried for BWART 101/102) never
// actually returned data from ZRFC_READ_TABLES, so SapServer now makes two
// separate single-value-EQ calls per sync (one per movement type, merged
// server-side) and no longer uses a materials list at all. `materials` is
// deliberately NOT sent/required here any more — see the reverted
// `!materials.length` guards that used to gate both call sites below.
// Timeout stays at 3min (2026-07-30): once BWART was actually filtering
// correctly, a first-ever sync for a vendor with years of GR history — no
// sinceDate cap is passed here or from the daily cron's runConsignmentSync —
// legitimately exceeded 45s and the call was aborted client-side before SAP
// finished. This is the same class of problem as the balance dashboard's
// stock call (see fetchSapConsignmentStock below): a narrower,
// plant+vendor+movement-type-filtered query than that unfiltered plant-wide
// MKOL scan, so it doesn't need that same 10-minute allowance, but 45s was
// too tight for real data.
async function fetchSapVendorGr(sapVendorNumber, sinceDate) {
  const response = await axios.get(`${sapConfig.url}/api/consignment/gr`, {
    params: { sapVendorNumber, sinceDate },
    timeout: 3 * 60 * 1000, httpsAgent: sapAgent,
    headers: { Authorization: `Bearer ${makeSapToken()}` },
  });
  const body = response.data;
  if (!body.success) throw new Error((typeof body.error === 'string' ? body.error : body.error?.message) ?? 'SapServer returned success=false');
  return body.data;
}

// Queries SapServer's GET /api/consignment/stock (MKOL SLABS, plant-wide,
// same reused query already proven for MRP) — see ConsignmentController.cs.
// Timeout matches performancesap.js's 10-minute client used for the
// turns-valclass MRP sync, which calls this exact same
// BuildConsignmentStockRequest RFC — that's the established precedent for
// how slow this unfiltered plant-wide MKOL scan can legitimately be. The
// balance dashboard's first 30s timeout was too tight and failed on a real
// vendor lookup (2026-07-30).
export async function fetchSapConsignmentStock() {
  const response = await axios.get(`${sapConfig.url}/api/consignment/stock`, {
    timeout: 10 * 60 * 1000, httpsAgent: sapAgent,
    headers: { Authorization: `Bearer ${makeSapToken()}` },
  });
  const body = response.data;
  if (!body.success) throw new Error((typeof body.error === 'string' ? body.error : body.error?.message) ?? 'SapServer returned success=false');
  return body.data; // { [material]: qty }
}

// Pulls fresh stock from SAP and writes it into log.ConsignmentStockSnapshot
// — the balance dashboard reads that cache (db.getConsignmentStockSnapshot)
// rather than calling fetchSapConsignmentStock() itself, so a page load is
// an instant SQL read instead of waiting on this potentially multi-minute
// RFC call. Called from the daily cron (runConsignmentSync, below) and from
// the manual POST /stock/refresh route.
export async function refreshConsignmentStockSnapshot() {
  const stockByMaterial = await fetchSapConsignmentStock();
  return db.replaceConsignmentStockSnapshot(stockByMaterial);
}

// SAP dd.mm.yyyy -> DATETIME parse helper (GR dates come back from SapServer
// in SAP GUI format, same convention as everywhere else this codebase parses
// them from ZRFC_READ_TABLES output).
function parseSapDate(raw) {
  if (!raw) return null;
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
}

// ── Vendors + config ──────────────────────────────────────────────────────────

router.get('/vendors', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    res.json({ success: true, data: await db.listConsignmentVendors() });
  } catch (err) { fail(res, err); }
});

router.get('/vendors/:vendorId', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const vendor = await db.getConsignmentVendor(req.params.vendorId);
    if (!vendor) return res.status(404).json({ success: false, error: { message: 'Vendor not found.' } });
    const materials = await db.listVendorMaterials(req.params.vendorId);
    res.json({ success: true, data: { ...vendor, materials } });
  } catch (err) { fail(res, err); }
});

router.put('/vendors/:vendorId/config', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const data = await db.upsertConsignmentVendorConfig(req.params.vendorId, req.body, actor(req));
    await audit('SAP_OK', actor(req), `Updated consignment config for vendor ${req.params.vendorId}`, req);
    res.json({ success: true, data });
  } catch (err) { fail(res, err); }
});

// ── Balance dashboard ─────────────────────────────────────────────────────────
//
// Delivered/Declared come from SQL (db.getVendorDeliveredAndDeclaredTotals);
// current stock comes from the daily-refreshed log.ConsignmentStockSnapshot
// cache (db.getConsignmentStockSnapshot), NOT a live SAP call — see
// sql/migrate_consignment_stock_snapshot.sql for why: the underlying MKOL
// scan is unfiltered and plant-wide, and calling it synchronously on every
// dashboard open meant users waiting minutes for a page load. See the SQL
// migration header (migrate_consignment_tracker.sql) for why "undeclared"
// is computed as a balance rather than pulled as a raw SAP consumption
// event. Also flags delivery lines expiring within the vendor's
// ExpiryWarningDays window, when TrackExpiry is on.
router.get('/vendors/:vendorId/balance', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const vendorId = req.params.vendorId;
    const vendor = await db.getConsignmentVendor(vendorId);
    if (!vendor) return res.status(404).json({ success: false, error: { message: 'Vendor not found.' } });

    const [totals, stockByMaterial, stockSnapshot] = await Promise.all([
      db.getVendorDeliveredAndDeclaredTotals(vendorId),
      db.getConsignmentStockSnapshot(),
      db.getConsignmentStockSnapshotMeta(),
    ]);

    const materials = totals.map(t => {
      const material = t.Material;
      const delivered = Number(t.Delivered) || 0;
      const declared   = Number(t.Declared) || 0;
      // MKOL's per-material key strips leading zeros on purely-numeric
      // materials (PerformanceHelpers.NormaliseMaterial) — Raaj's own
      // materials (e.g. "30005R") aren't purely numeric so pass through
      // unchanged; try both forms defensively.
      const stock = Number(stockByMaterial[material] ?? stockByMaterial[material.replace(/^0+/, '')] ?? 0);
      const undeclared = Math.round((delivered - stock - declared) * 1000) / 1000;
      return { material, delivered, currentStock: stock, declared, undeclared: Math.max(0, undeclared) };
    });

    let expiryWarnings = [];
    if (vendor.TrackExpiry) {
      const warningDays = vendor.ExpiryWarningDays ?? 30;
      const horizon = new Date(Date.now() + warningDays * 86400000);
      const allDeliveries = await db.listConsignmentDeliveries(vendorId);
      expiryWarnings = allDeliveries.filter(d =>
        Number(d.RemainingQty) > 0 && d.ExpiryDate && new Date(d.ExpiryDate) <= horizon
      );
    }

    res.json({ success: true, data: { vendor, materials, expiryWarnings, stockSnapshot } });
  } catch (err) { fail(res, err); }
});

// Manual "Refresh Now" for the stock snapshot cache — the daily 06:20 cron
// (see runConsignmentSync, below) covers the normal case; this is for
// anyone who needs fresher numbers before tomorrow morning's run. Can take
// several minutes (same unfiltered plant-wide MKOL scan) — the frontend
// shows its own loading state and disables the button while this is in
// flight, matching the turns-valclass "Refresh Now" pattern.
router.post('/stock/refresh', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const result = await refreshConsignmentStockSnapshot();
    await audit('SAP_OK', actor(req), `Manual consignment stock snapshot refresh: ${result.materialCount} materials`, req);
    res.json({ success: true, data: result });
  } catch (err) {
    await audit('SAP_ERROR', actor(req), 'Manual consignment stock snapshot refresh failed', req);
    fail(res, err);
  }
});

// ── Deliveries (GR lines) ────────────────────────────────────────────────────

router.get('/vendors/:vendorId/deliveries', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    res.json({ success: true, data: await db.listConsignmentDeliveries(req.params.vendorId, req.query.material) });
  } catch (err) { fail(res, err); }
});

router.post('/vendors/:vendorId/deliveries', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const deliveryId = await db.addManualConsignmentDelivery(req.params.vendorId, req.body, actor(req));
    await audit('SAP_OK', actor(req), `Manually added consignment delivery for vendor ${req.params.vendorId}, material ${req.body.material || ''}`, req);
    res.json({ success: true, data: { deliveryId } });
  } catch (err) { fail(res, err, 400); }
});

// Bulk CSV import — body: { rows: [{ material, quantity, uom, invoiceNumber,
// container, billOfLading, documentDate, postingDate, expiryDate }] },
// mirroring the old workbooks' GR tab columns exactly so existing exports
// can be pasted straight in without reshaping.
router.post('/vendors/:vendorId/deliveries/csv-import', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ success: false, error: { message: 'rows array is required.' } });

    let imported = 0;
    for (const row of rows) {
      if (!row.material || !row.quantity) continue;
      await db.addManualConsignmentDelivery(req.params.vendorId, { ...row, source: 'CSV' }, actor(req));
      imported++;
    }
    await audit('SAP_OK', actor(req), `CSV-imported ${imported} consignment deliveries for vendor ${req.params.vendorId}`, req);
    res.json({ success: true, data: { imported, skipped: rows.length - imported } });
  } catch (err) { fail(res, err, 400); }
});

router.put('/deliveries/:deliveryId', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    await db.updateConsignmentDelivery(req.params.deliveryId, req.body);
    res.json({ success: true });
  } catch (err) { fail(res, err, 400); }
});

// SAP GR sync — pulls consignment goods receipts for this vendor (blocked
// with a clear error if SapVendorNumber isn't set yet, same defensive
// pattern as PO creation) and upserts any not already known. Also called
// from the daily cron (see server.js) for every vendor automatically —
// exposed here too so a user can force a refresh from the tile.
router.post('/vendors/:vendorId/sync', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const vendor = await db.getConsignmentVendor(req.params.vendorId);
    if (!vendor) return res.status(404).json({ success: false, error: { message: 'Vendor not found.' } });
    if (!vendor.SapVendorNumber) {
      return res.status(422).json({ success: false, error: { message:
        `${vendor.VendorName} has no SAP vendor number set — add one on the Vendor Master Data page before syncing GR data from SAP.` } });
    }

    const grRows = await fetchSapVendorGr(vendor.SapVendorNumber);
    const mapped = grRows.map(r => ({
      material:         r.material,
      materialDocument: r.materialDocument,
      materialDocItem:  r.materialDocItem,
      quantity:         r.quantity,
      uom:              r.uom,
      invoiceNumber:    r.invoiceNumber,
      documentDate:     parseSapDate(r.documentDate),
      postingDate:      parseSapDate(r.postingDate),
    }));

    const { inserted } = await db.upsertConsignmentDeliveriesFromSap(req.params.vendorId, mapped);
    await audit('SAP_OK', actor(req), `Consignment GR sync for ${vendor.VendorName}: ${inserted} new deliveries`, req);
    res.json({ success: true, data: { pulled: grRows.length, inserted } });
  } catch (err) {
    await audit('SAP_ERROR', actor(req), `Consignment GR sync failed for vendor ${req.params.vendorId}`, req);
    fail(res, err);
  }
});

// ── Declaration proposal + lifecycle ─────────────────────────────────────────

// Builds (without saving) a FEFO/FIFO/manual proposal for one material —
// body: { material, qtyToDeclare, method? } — method defaults to the
// vendor's DefaultAllocationMethod. FEFO/FIFO both use the same
// listConsignmentDeliveries ORDER BY (ExpiryDate then DocumentDate), which
// already puts the FEFO/FIFO-correct row first in every case that matters
// for these vendors: FIFO-only vendors never set ExpiryDate, so all rows
// tie on the ISNULL(ExpiryDate,'9999-12-31') clause and fall through to
// DocumentDate ordering anyway. MANUAL returns every open line unallocated,
// for the user to allocate qty against by hand in the UI.
router.post('/vendors/:vendorId/declarations/propose', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { material, qtyToDeclare, method } = req.body;
    if (!material || !qtyToDeclare) {
      return res.status(400).json({ success: false, error: { message: 'material and qtyToDeclare are required.' } });
    }

    const vendor = await db.getConsignmentVendor(req.params.vendorId);
    if (!vendor) return res.status(404).json({ success: false, error: { message: 'Vendor not found.' } });
    const effectiveMethod = method || vendor.DefaultAllocationMethod || 'FIFO';

    const openLines = (await db.listConsignmentDeliveries(req.params.vendorId, material))
      .filter(d => Number(d.RemainingQty) > 0);

    if (effectiveMethod === 'MANUAL') {
      return res.json({ success: true, data: { method: effectiveMethod, lines: [], openLines, unallocatedQty: Number(qtyToDeclare) } });
    }

    const proposal = db.buildAllocationProposal(openLines, qtyToDeclare);
    res.json({ success: true, data: { method: effectiveMethod, ...proposal, openLines } });
  } catch (err) { fail(res, err, 400); }
});

router.post('/vendors/:vendorId/declarations', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { allocationMethod, lines } = req.body;
    if (!Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ success: false, error: { message: 'lines array is required.' } });
    }
    const declarationId = await db.createDeclaration(req.params.vendorId, allocationMethod, lines, actor(req));
    await audit('SAP_OK', actor(req), `Created draft consignment declaration #${declarationId} for vendor ${req.params.vendorId}`, req);
    res.json({ success: true, data: await db.getDeclaration(declarationId) });
  } catch (err) { fail(res, err, 400); }
});

router.get('/vendors/:vendorId/declarations', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    res.json({ success: true, data: await db.listDeclarations(req.params.vendorId) });
  } catch (err) { fail(res, err); }
});

router.get('/declarations/:declarationId', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const declaration = await db.getDeclaration(req.params.declarationId);
    if (!declaration) return res.status(404).json({ success: false, error: { message: 'Declaration not found.' } });
    res.json({ success: true, data: declaration });
  } catch (err) { fail(res, err); }
});

router.put('/declarations/:declarationId/lines', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { lines } = req.body;
    if (!Array.isArray(lines)) return res.status(400).json({ success: false, error: { message: 'lines array is required.' } });
    await db.setDeclarationLines(req.params.declarationId, lines);
    res.json({ success: true, data: await db.getDeclaration(req.params.declarationId) });
  } catch (err) { fail(res, err, 400); }
});

// The elevated step — see sql/migrate_vendor_consignment_permission.sql.
// Body: { settlementDocumentNumber, settlementReconciledQty? } — the MRKO
// document number (1700******) and optionally the qty MRKO actually
// settled, pasted back after the user runs MRKO themselves in SAP GUI.
router.post('/declarations/:declarationId/confirm', requirePermission('VENDOR_CONSIGNMENT'), async (req, res) => {
  try {
    const { settlementDocumentNumber, settlementReconciledQty } = req.body;

    // log.ConsignmentDeclaration.SettlementDocumentNumber is NVARCHAR(10)
    // (see migrate_consignment_tracker.sql) — a value that's too long or
    // non-numeric used to reach db.confirmDeclaration and fail inside the
    // SQL parameter binding with an opaque error (no clean .message),
    // which surfaced in the UI as a literal "undefined". Reject it here
    // instead, with a message that tells the user what a valid value looks
    // like, before it ever gets near the DB layer.
    const trimmedDoc = (settlementDocumentNumber ?? '').toString().trim();
    if (trimmedDoc && !/^\d{1,10}$/.test(trimmedDoc)) {
      return res.status(400).json({ success: false, error: { message:
        `"${settlementDocumentNumber}" isn't a valid settlement document number — SAP MRKO settlement documents are numeric, up to 10 digits (e.g. 1700003535).` } });
    }

    const data = await db.confirmDeclaration(req.params.declarationId, trimmedDoc || null, settlementReconciledQty, actor(req));
    await audit('SAP_OK', actor(req), `Confirmed consignment declaration #${req.params.declarationId} — settlement doc ${settlementDocumentNumber || '(none)'}`, req);
    res.json({ success: true, data });
  } catch (err) { fail(res, err, 400); }
});

// Printable declaration to send to the supplier — see
// lib/consignmentDeclarationPdf.js. Works for a Draft (preview before
// confirming) or a Confirmed declaration alike.
router.get('/declarations/:declarationId/pdf', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const declaration = await db.getDeclaration(req.params.declarationId);
    if (!declaration) return res.status(404).json({ success: false, error: { message: 'Declaration not found.' } });

    const vendor = await db.getConsignmentVendor(declaration.VendorId);

    // Per-material Starting Stock / Deliveries, since this material's
    // previous Confirmed declaration — see getConsignmentDeclarationStockSummary.
    // Consumption/Ending Stock are derived here from the declaration's own
    // lines rather than re-queried, since we already have QtyAllocated.
    const materials = [...new Set(declaration.lines.map(l => l.Material))];
    const stockSummary = await db.getConsignmentDeclarationStockSummary(declaration.VendorId, declaration.DeclarationId, materials);
    const materialSummaries = materials.map(material => {
      const consumption = declaration.lines
        .filter(l => l.Material === material)
        .reduce((s, l) => s + Number(l.QtyAllocated), 0);
      const { startingStock = 0, deliveries = 0 } = stockSummary[material] || {};
      return { material, startingStock, deliveries, consumption, endingStock: startingStock - consumption };
    });

    const pdf = await buildConsignmentDeclarationPdf({
      declarationId: declaration.DeclarationId,
      vendorName: declaration.VendorName,
      sapVendorNumber: vendor?.SapVendorNumber,
      status: declaration.Status,
      allocationMethod: declaration.AllocationMethod,
      totalQty: declaration.TotalQty,
      createdAtUtc: declaration.CreatedAtUtc,
      settlementDocumentNumber: declaration.SettlementDocumentNumber,
      materialSummaries,
      lines: declaration.lines.map(l => ({
        material: l.Material,
        invoiceNumber: l.InvoiceNumber,
        materialDocument: l.MaterialDocument,
        expiryDate: l.ExpiryDate,
        qtyAllocated: l.QtyAllocated,
        uom: l.Uom,
      })),
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Consignment-Declaration-${declaration.DeclarationId}.pdf"`);
    res.send(pdf);
  } catch (err) { fail(res, err); }
});

router.post('/declarations/:declarationId/cancel', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    await db.cancelDeclaration(req.params.declarationId);
    await audit('SAP_OK', actor(req), `Cancelled draft consignment declaration #${req.params.declarationId}`, req);
    res.json({ success: true });
  } catch (err) { fail(res, err, 400); }
});

// ── Daily cron entry point ───────────────────────────────────────────────────
//
// Pulls fresh GR data for every active consignment vendor that has a
// SapVendorNumber set — see server.js's 06:20 cron slot. Vendors missing a
// SapVendorNumber are skipped (not an error): Chemours/Fothergill start out
// that way until someone fills it in via Vendor Master Data, same as the
// per-request /sync route's own guard.
//
// Also refreshes log.ConsignmentStockSnapshot once, AFTER the per-vendor GR
// loop finishes — deliberately sequential, not concurrent with the GR
// pulls, so this doesn't compete with them for a SapServer connection-pool
// worker slot. This is what lets the balance dashboard read stock from SQL
// instead of making its own live SAP call (see the /stock/refresh route and
// migrate_consignment_stock_snapshot.sql for the full rationale).
export async function runConsignmentSync() {
  const vendors = await db.listConsignmentVendors();
  const results = [];

  for (const vendor of vendors) {
    if (!vendor.Active || !vendor.SapVendorNumber) {
      results.push({ vendor: vendor.VendorName, skipped: true });
      continue;
    }
    try {
      const grRows = await fetchSapVendorGr(vendor.SapVendorNumber);
      const mapped = grRows.map(r => ({
        material:         r.material,
        materialDocument: r.materialDocument,
        materialDocItem:  r.materialDocItem,
        quantity:         r.quantity,
        uom:              r.uom,
        invoiceNumber:    r.invoiceNumber,
        documentDate:     parseSapDate(r.documentDate),
        postingDate:      parseSapDate(r.postingDate),
      }));
      const { inserted } = await db.upsertConsignmentDeliveriesFromSap(vendor.VendorId, mapped);
      results.push({ vendor: vendor.VendorName, pulled: grRows.length, inserted });
    } catch (err) {
      console.error(`[consignment cron] GR sync failed for ${vendor.VendorName}:`, err.message);
      results.push({ vendor: vendor.VendorName, error: err.message });
    }
  }

  try {
    const stockResult = await refreshConsignmentStockSnapshot();
    results.push({ stockSnapshot: true, materialCount: stockResult.materialCount });
  } catch (err) {
    console.error('[consignment cron] stock snapshot refresh failed:', err.message);
    results.push({ stockSnapshot: true, error: err.message });
  }

  return results;
}

export default router;
