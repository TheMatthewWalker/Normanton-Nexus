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
import { sapConfig, sapServerSecret, sqlConfig } from '../config.js';
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
    { issuer: 'sql2005-bridge', audience: 'sap-server', expiresIn: '60s' }
  );
}

async function audit(eventType, username, detail, req) {
  try {
    const pool = await sql.connect(sqlConfig);
    const ip = req?.ip || req?.socket?.remoteAddress || null;
    await pool.request()
      .input('username',  sql.NVarChar(80),  username || null)
      .input('eventType', sql.NVarChar(50),  eventType)
      .input('detail',    sql.NVarChar(500), detail || null)
      .input('ip',        sql.NVarChar(45),  ip)
      .query(`INSERT INTO kongsberg.dbo.PortalAuditLog (Username, EventType, Detail, IPAddress)
              VALUES (@username, @eventType, @detail, @ip)`);
  } catch (err) {
    console.error('[consignment audit]', err.message);
  }
}

function actor(req) {
  return req.session?.user?.username || 'unknown';
}

function fail(res, err, status = 500) {
  console.error('[consignment]', err.message);
  res.status(status).json({ success: false, error: { message: err.message } });
}

// Queries SapServer's GET /api/consignment/gr — see ConsignmentHelpers.cs.
async function fetchSapVendorGr(sapVendorNumber, sinceDate) {
  const response = await axios.get(`${sapConfig.url}/api/consignment/gr`, {
    params: { sapVendorNumber, sinceDate },
    timeout: 45000, httpsAgent: sapAgent,
    headers: { Authorization: `Bearer ${makeSapToken()}` },
  });
  const body = response.data;
  if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');
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
  if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');
  return body.data; // { [material]: qty }
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
// current stock is a fresh SAP pull every time this is called — see the SQL
// migration header for why "undeclared" is computed as this balance rather
// than pulled as a raw SAP consumption event. Also flags delivery lines
// expiring within the vendor's ExpiryWarningDays window, when TrackExpiry is on.
router.get('/vendors/:vendorId/balance', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const vendorId = req.params.vendorId;
    const vendor = await db.getConsignmentVendor(vendorId);
    if (!vendor) return res.status(404).json({ success: false, error: { message: 'Vendor not found.' } });

    const [totals, stockByMaterial] = await Promise.all([
      db.getVendorDeliveredAndDeclaredTotals(vendorId),
      fetchSapConsignmentStock(),
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

    res.json({ success: true, data: { vendor, materials, expiryWarnings } });
  } catch (err) { fail(res, err); }
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
    const data = await db.confirmDeclaration(req.params.declarationId, settlementDocumentNumber, settlementReconciledQty, actor(req));
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
    const pdf = await buildConsignmentDeclarationPdf({
      declarationId: declaration.DeclarationId,
      vendorName: declaration.VendorName,
      sapVendorNumber: vendor?.SapVendorNumber,
      status: declaration.Status,
      allocationMethod: declaration.AllocationMethod,
      totalQty: declaration.TotalQty,
      createdAtUtc: declaration.CreatedAtUtc,
      settlementDocumentNumber: declaration.SettlementDocumentNumber,
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

  return results;
}

export default router;
