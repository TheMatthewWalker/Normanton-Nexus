// routes/staging.js
//
// Staging Post — material requisitions from Production to Stores. See
// sql/migrate_staging_post.sql for the full schema + workflow writeup.
//
// SAP calls (stock lookup + transfer order creation) go straight to
// SapServer here rather than through routes/sap.js's proxies — same
// per-file boilerplate pattern as productionnexus.js/deliverymain.js/
// quality.js, each of which owns its own makeSapToken/sapAgent/audit rather
// than sharing one across route files.

import express from 'express';
import sql     from 'mssql';
import axios   from 'axios';
import https   from 'https';
import fs      from 'fs';
import jwt     from 'jsonwebtoken';
import ExcelJS from 'exceljs';
import { sapConfig, sapServerSecret, getNexusPool } from '../config.js';
import { maybeReverseBatchManagedReturn } from '../lib/redrumReversal.js';
import { requirePermission } from '../middleware/auth.js';
import { notify } from '../lib/notify.js';
import { assertTransfersAllowed } from '../lib/stockCountGuard.js';
import * as db from './stagingsql.js';
import { getConversionQty } from './materialRequestUnits.js';

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
    console.error('[staging audit]', err.message);
  }
}

function actor(req) {
  return req.session?.user?.username || 'unknown';
}

// Queries SapServer's existing GET /api/warehouse/stock (LQUA via
// ZRFC_READ_TABLES, BuildStockRequest in WarehouseHelpers.cs) — already
// filterable by material/storage type/bin/batch, no SapServer changes
// needed for Staging Post.
async function fetchLquaStock({ material, batch, storageType, bin }) {
  const response = await axios.get(`${sapConfig.url}/api/warehouse/stock`, {
    params: { material, batch, storageType, bin, rowCount: 9999 },
    timeout: 30000,
    httpsAgent: sapAgent,
    headers: { Authorization: `Bearer ${makeSapToken()}` },
  });
  const body = response.data;
  if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');
  // The SAP field-name header row is skipped server-side in
  // WarehouseHelpers.ParseStockRows (SapDelimitedParser.ParseRows with
  // skipHeader: true), same as every other table-read helper there.
  return body.data;
}

// SapServer's existing POST /api/warehouse/transfer-order (L_TO_CREATE_SINGLE) —
// same endpoint private/js/warehouse.js's Stock Transfer tool already uses.
// Guarded by the stock-count transfer block here directly (not inherited
// from routes/sap.js's proxy — Staging Post calls SapServer straight, per
// this file's own header comment), since this is the one place in this
// file that actually moves stock.
async function createSapTransferOrder(body) {
  await assertTransfersAllowed(body.StorageLocation);

  const response = await axios.post(`${sapConfig.url}/api/warehouse/transfer-order`, body, {
    timeout: 60000,
    httpsAgent: sapAgent,
    headers: { Authorization: `Bearer ${makeSapToken()}` },
  });
  const responseBody = response.data;
  if (!responseBody.success) throw new Error(responseBody.error ?? 'SapServer returned success=false');
  return responseBody.data;
}

// SapServer's existing POST /api/warehouse/consignment-mb1b (MB1B + LT01
// non-consign/consign pair) — same endpoint private/js/warehouse.js's Stock
// Transfer tool already switches to whenever SpecialStockIndicator is 'K'
// (consignment) and the destination is SA/PTFE. Required so consignment
// stock is actually posted out of consignment (MB1B) rather than just moved
// bin-to-bin, which would leave it showing as consignment stock in SAP while
// physically sitting in Production.
async function createSapConsignmentMb1b(body) {
  try {
    const response = await axios.post(`${sapConfig.url}/api/warehouse/consignment-mb1b`, body, {
      timeout: 60000,
      httpsAgent: sapAgent,
      headers: { Authorization: `Bearer ${makeSapToken()}` },
    });
    const responseBody = response.data;
    if (!responseBody.success) throw new Error(responseBody.error ?? 'SapServer returned success=false');
    return responseBody.data;
  } catch (err) {
    // A rejected MB1B/LT01 leg comes back as an HTTP 422 (deficit stock,
    // missing authorization, etc.) — axios throws on that before the
    // success/error body above is ever read, so pull SapServer's real
    // message out of the rejected response instead of surfacing axios's
    // generic "Request failed with status code 422".
    throw new Error(err.response?.data?.error?.message ?? err.message);
  }
}

// Minimum lead time a production request can specify — protects Stores from
// being asked for an impossible immediate turnaround. No upper bound.
const NEEDED_BY_MIN_LEAD_HOURS = 4;
// Grace period so picking the "4 hours" preset and submitting a little while
// later never spuriously fails the minimum-lead-time check below.
const NEEDED_BY_GRACE_MINUTES = 5;

// ── Stores working hours (Needed By lead time) ──────────────────────────────
// Stores only work 05:45–17:00, Monday–Friday — no weekend shift. The
// 4-hour minimum lead time above is counted in *working* time, not flat
// clock time: a request raised outside that window (evenings, nights,
// weekends) has its 4 hours start from the next 05:45 open rather than
// landing at some hour nobody's there to see, and a request raised close to
// the 17:00 close has the overflow carry over into the next working day's
// morning (e.g. a 4-hour request at 15:00 lands at 07:45 the next working
// day — 2 hours to close, 2 more from 05:45).
const STORES_OPEN  = { hours: 5,  minutes: 45 };
const STORES_CLOSE = { hours: 17, minutes: 0 };

function isStoresWorkingDay(date) {
  const day = date.getDay(); // 0 = Sunday, 6 = Saturday
  return day >= 1 && day <= 5;
}

function atLocalTime(date, { hours, minutes }) {
  const d = new Date(date);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

// Next instant at/after `date` that Stores are open — same day if `date` is
// before today's open, otherwise the following working day's 05:45.
function nextStoresOpen(date) {
  const d = atLocalTime(date, STORES_OPEN);
  if (d < date) d.setDate(d.getDate() + 1);
  while (!isStoresWorkingDay(d)) d.setDate(d.getDate() + 1);
  return d;
}

// Rolls `date` forward to the next moment Stores are actually open —
// unchanged if `date` already falls inside today's working window.
function clampToStoresWindow(date) {
  if (isStoresWorkingDay(date)) {
    const open = atLocalTime(date, STORES_OPEN);
    const close = atLocalTime(date, STORES_CLOSE);
    if (date >= open && date < close) return new Date(date);
  }
  return nextStoresOpen(date);
}

// Adds `hours` of Stores working time to `fromDate`, rolling any time past
// 17:00 over to the next working day's 05:45 (weekends skipped).
function addStoresLeadTime(fromDate, hours) {
  let cursor = clampToStoresWindow(fromDate);
  let remainingMs = hours * 60 * 60 * 1000;
  while (remainingMs > 0) {
    const close = atLocalTime(cursor, STORES_CLOSE);
    const availableMs = close - cursor;
    if (remainingMs <= availableMs) {
      cursor = new Date(cursor.getTime() + remainingMs);
      remainingMs = 0;
    } else {
      remainingMs -= availableMs;
      cursor = nextStoresOpen(new Date(close.getTime() + 1));
    }
  }
  return cursor;
}

function formatStoresTime(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ── Material search (no LOG_MRP gate — see stagingsql.js's searchMaterials) ──

router.get('/materials', async (req, res) => {
  try {
    const { search, by } = req.query;
    if (!search || !String(search).trim()) return res.json({ success: true, data: [] });
    const data = await db.searchMaterials(search, by === 'description' ? 'description' : 'material');
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Requests ─────────────────────────────────────────────────────────────────

router.get('/requests/open', async (req, res) => {
  try {
    const data = await db.listOpenStagingRequests();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Tile-badge summary for the warehouse Staging Post tile — open count +
// overdue count, cheap enough to poll every 60s without pulling full rows.
router.get('/requests/open-summary', async (req, res) => {
  try {
    const data = await db.getStagingOpenSummary();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/requests', async (req, res) => {
  try {
    const data = await db.listStagingRequests();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/requests/completed', async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : null;
    const to   = req.query.to   ? new Date(req.query.to)   : null;
    const data = await db.listCompletedStagingRequests({ from, to });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/requests/:id', async (req, res) => {
  try {
    const request = await db.getStagingRequestById(req.params.id);
    if (!request) return res.status(404).json({ success: false, error: { message: 'Request not found.' } });
    const deliveries = await db.listStagingRequestDeliveries(req.params.id);
    res.json({ success: true, data: { ...request, deliveries } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/requests', async (req, res) => {
  try {
    const { material, materialText, uom, location, requestedBatch, dueAtUtc, notes, requestUnit, requestUnitQty } = req.body;
    let { quantityRequested } = req.body;

    if (!material || !String(material).trim()) {
      return res.status(400).json({ success: false, error: { message: 'material is required.' } });
    }

    // Unit-based requests ("1 Spool") are converted to the base KG figure
    // server-side from log.MaterialRequestUnits — never trust a
    // client-computed KG number, so a stale/tampered unit dropdown can't
    // slip Stores/SAP a wrong quantity. Materials with no configured units
    // fall back to the pre-existing direct-quantity path.
    if (requestUnit) {
      if (!(Number(requestUnitQty) > 0)) {
        return res.status(400).json({ success: false, error: { message: 'requestUnitQty must be greater than zero.' } });
      }
      try {
        const conversionQty = await getConversionQty(material, requestUnit);
        quantityRequested = Number(requestUnitQty) * conversionQty;
      } catch (conversionErr) {
        return res.status(400).json({ success: false, error: { message: conversionErr.message } });
      }
    } else if (!(Number(quantityRequested) > 0)) {
      return res.status(400).json({ success: false, error: { message: 'quantityRequested must be greater than zero.' } });
    }

    if (!location || !String(location).trim()) {
      return res.status(400).json({ success: false, error: { message: 'location is required.' } });
    }
    if (!dueAtUtc) {
      return res.status(400).json({ success: false, error: { message: 'dueAtUtc (Needed By) is required.' } });
    }
    const due = new Date(dueAtUtc);
    const minDue = new Date(
      addStoresLeadTime(new Date(), NEEDED_BY_MIN_LEAD_HOURS).getTime() - NEEDED_BY_GRACE_MINUTES * 60 * 1000
    );
    if (due < minDue) {
      return res.status(400).json({
        success: false,
        error: {
          message: `Needed By must allow at least ${NEEDED_BY_MIN_LEAD_HOURS} working hours' notice — Stores works 05:45–17:00, Monday–Friday. The earliest available time is ${formatStoresTime(minDue)}.`,
        },
      });
    }

    const requestedBy = actor(req);
    const requestId = await db.createStagingRequest({
      material, materialText, uom, quantityRequested, location, requestedBatch, dueAtUtc: due, notes, requestedBy,
      requestUnit: requestUnit || null, requestUnitQty: requestUnit ? Number(requestUnitQty) : null,
    });
    await audit('STAGING_REQUEST_CREATED', requestedBy, `Request #${requestId} — ${quantityRequested} of ${material} to ${location}`, req);

    // Let the warehouse department know a new request is waiting — best-effort,
    // must never block the response the requester is waiting on.
    try {
      const pool = await getNexusPool();
      await notify(pool, {
        title: 'New Staging Post Request',
        body: `${requestedBy} requested ${quantityRequested}${uom ? ` ${uom}` : ''} of ${material} to ${location}, needed by ${due.toISOString().slice(0, 16).replace('T', ' ')}.`,
        severity: 1,
        category: 'logistics',
        actionLabel: 'Open Staging Post',
        actionURL: '/private/warehouse.html',
        target: { type: 'department', value: 'warehouse' },
      });
    } catch (notifyErr) {
      console.error('[staging notify]', notifyErr.message);
    }

    res.json({ success: true, data: { requestId } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/requests/:id/cancel', async (req, res) => {
  try {
    const ok = await db.cancelStagingRequest(req.params.id, actor(req));
    if (!ok) {
      return res.status(400).json({
        success: false,
        error: { message: 'This request can no longer be cancelled — it may already have a delivery against it, or already be closed.' },
      });
    }
    await audit('STAGING_REQUEST_CANCELLED', actor(req), `Request #${req.params.id}`, req);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/requests/:id/complete', async (req, res) => {
  try {
    const ok = await db.completeStagingRequest(req.params.id, actor(req));
    if (!ok) {
      return res.status(400).json({ success: false, error: { message: 'This request is no longer open.' } });
    }
    await audit('STAGING_REQUEST_COMPLETED', actor(req), `Request #${req.params.id}`, req);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Bare material stock lookup — used by the request form's optional batch
// picker (offered whenever LQUA actually has batches for the material the
// requester just picked, before any StagingRequest row exists yet to hang
// the fuller /requests/:id/stock lookup off).
router.get('/stock', async (req, res) => {
  try {
    const { material } = req.query;
    if (!material || !String(material).trim()) {
      return res.status(400).json({ success: false, error: { message: 'material is required.' } });
    }
    const data = await fetchLquaStock({ material });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Stock lookup (Stores' click-through view) ─────────────────────────────────
//
// Whole-material stock, not just the allowed bins — restricted bins are
// flagged (isAllowed), not filtered out, so Stores can still see stock that
// exists in a non-permitted bin rather than wrongly concluding there's none
// at all. If the request specifies a batch, the query is pre-filtered to
// just that batch (a specific-drum request), matching the "just show them
// where that batch is" requirement.

router.get('/requests/:id/stock', async (req, res) => {
  try {
    const request = await db.getStagingRequestById(req.params.id);
    if (!request) return res.status(404).json({ success: false, error: { message: 'Request not found.' } });

    const [stockRows, restrictions] = await Promise.all([
      fetchLquaStock({ material: request.Material, batch: request.RequestedBatch || undefined }),
      db.getBinRestrictionsForMaterial(request.Material),
    ]);

    const isAllowed = row => {
      if (!restrictions.length) return true; // no restriction configured — every bin is fair game
      return restrictions.some(r =>
        r.StorageType === row.storageType && (r.Bin == null || r.Bin === row.bin)
      );
    };

    const data = stockRows.map(row => ({ ...row, isAllowed: isAllowed(row) }));
    res.json({ success: true, data: { stock: data, hasRestrictions: restrictions.length > 0, requestedBatch: request.RequestedBatch || null } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Mark Delivered ───────────────────────────────────────────────────────────
//
// Creates the real SAP transfer order first (existing L_TO_CREATE_SINGLE
// endpoint) — only records the delivery against the request if SAP actually
// accepted it, so the audit trail never shows a delivery that didn't really
// happen in SAP.

router.post('/requests/:id/deliver', async (req, res) => {
  const {
    quantity, batch, storageLocation, sourceStorageType, sourceBin,
    destinationStorageType, destinationBin, stockCategory,
    specialStockIndicator, specialStockNumber,
  } = req.body;

  try {
    const request = await db.getStagingRequestById(req.params.id);
    if (!request) return res.status(404).json({ success: false, error: { message: 'Request not found.' } });
    if (request.Status !== 'Open') {
      return res.status(400).json({ success: false, error: { message: 'This request is no longer open.' } });
    }
    if (!(Number(quantity) > 0)) {
      return res.status(400).json({ success: false, error: { message: 'quantity must be greater than zero.' } });
    }
    if (!storageLocation || !sourceStorageType || !sourceBin || !destinationStorageType || !destinationBin) {
      return res.status(400).json({
        success: false,
        error: { message: 'Storage location, source bin/type and destination bin/type are all required.' },
      });
    }

    // Consignment stock (LQUA-SOBKZ = 'K') moving into a production bin needs
    // the MB1B + LT01 pair, not a plain transfer order — same rule
    // private/js/warehouse.js's manual Stock Transfer tool already applies
    // (see runStockTransfer's isConsignment check there).
    const isConsignment = specialStockIndicator === 'K' && destinationStorageType === 'SA';
    if (isConsignment && !specialStockNumber) {
      return res.status(400).json({
        success: false,
        error: { message: 'This stock is held as consignment stock (SOBKZ K) — a special stock number (vendor) is required to issue it.' },
      });
    }

    let transferOrder;
    try {
      if (isConsignment) {
        const mb1b = await createSapConsignmentMb1b({
          Material: request.Material,
          Quantity: Number(quantity),
          Header: `Staging Post fulfilment — Request #${req.params.id}`,
          SpecialStockNumber: specialStockNumber,
          StorageLocation: storageLocation,
          SourceType: sourceStorageType,
          SourceBin: sourceBin,
          DestinationType: destinationStorageType,
          DestinationBin: destinationBin,
        });
        // mb1b.success reflects whether SAP actually accepted all three legs
        // (MB1B goods issue + both LT01 transfer postings) — previously this
        // was hardcoded to true with every message force-labelled type 'S',
        // so a rejected MB1B (deficit stock, etc.) still recorded a
        // "successful" delivery below even though the stock never left
        // consignment. See WarehouseHelpers.ParseConsignmentResponse.
        transferOrder = {
          success: mb1b.success,
          transferOrderNumber: null,
          messages: [mb1b.mb1bMessage, mb1b.toNonConsignMessage, mb1b.toConsignMessage]
            .filter(Boolean)
            .map(message => ({ type: message.startsWith('E ') ? 'E' : 'S', message })),
        };
      } else {
        transferOrder = await createSapTransferOrder({
          StorageLocation: storageLocation,
          Material: request.Material,
          Quantity: Number(quantity),
          SourceType: sourceStorageType,
          SourceBin: sourceBin,
          DestinationType: destinationStorageType,
          DestinationBin: destinationBin,
          Batch: batch || request.RequestedBatch || undefined,
          StockCategory: stockCategory || undefined,
          SpecialStockIndicator: specialStockIndicator || undefined,
          SpecialStockNumber: specialStockNumber || undefined,
        });
      }
    } catch (sapErr) {
      await audit('STAGING_DELIVER_SAP_ERROR', actor(req), `Request #${req.params.id} — ${sapErr.message}`, req);
      return res.status(422).json({
        success: false,
        error: { message: `SAP rejected the ${isConsignment ? 'consignment issue' : 'transfer order'}: ${sapErr.message}` },
      });
    }

    if (!transferOrder.success) {
      const messages = (transferOrder.messages || []).map(m => m.message).join('; ');
      return res.status(422).json({
        success: false,
        error: { message: messages || 'SAP rejected the transfer order.' },
        data: { messages: transferOrder.messages || [] },
      });
    }

    const result = await db.recordStagingDelivery(req.params.id, {
      quantityMoved: Number(quantity),
      batch: batch || request.RequestedBatch || null,
      sourceStorageType, sourceBin, destinationStorageType, destinationBin,
      transferOrderNumber: transferOrder.transferOrderNumber,
      deliveredBy: actor(req),
    });

    await audit('STAGING_DELIVERED', actor(req), `Request #${req.params.id} — ${quantity} moved, TO ${transferOrder.transferOrderNumber}`, req);

    const redrum = await maybeReverseBatchManagedReturn({
      batch: batch || request.RequestedBatch || null,
      destinationStorageType, destinationBin, storageLocation,
      audit, actorUsername: actor(req), req,
    });

    res.json({
      success: true,
      data: {
        transferOrderNumber: transferOrder.transferOrderNumber,
        messages: transferOrder.messages || [],
        ...result,
        ...(redrum ? { redrum } : {}),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── KPIs ───────────────────────────────────────────────────────────────────────

router.get('/kpi', async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : null;
    const to   = req.query.to   ? new Date(req.query.to)   : null;
    const data = await db.computeStagingKpis({ from, to });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/kpi/export', async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : null;
    const to   = req.query.to   ? new Date(req.query.to)   : null;
    const [{ overall, byMaterial }, requests] = await Promise.all([
      db.computeStagingKpis({ from, to }),
      db.listCompletedStagingRequests({ from, to }),
    ]);

    const wb = new ExcelJS.Workbook();

    const summaryWs = wb.addWorksheet('Summary');
    summaryWs.columns = [{ width: 28 }, { width: 20 }];
    summaryWs.addRow(['Staging Post — Fulfilment KPIs']).font = { bold: true, size: 14 };
    summaryWs.addRow([`Range: ${from ? from.toISOString().slice(0, 10) : 'all time'} to ${to ? to.toISOString().slice(0, 10) : 'now'}`]);
    summaryWs.addRow([]);
    summaryWs.addRow(['Completed Requests', overall.CompletedCount || 0]);
    summaryWs.addRow(['On-Time Count', overall.OnTimeCount || 0]);
    const onTimePct = overall.CompletedCount ? (100 * overall.OnTimeCount / overall.CompletedCount) : 0;
    summaryWs.addRow(['On-Time %', `${onTimePct.toFixed(1)}%`]);
    summaryWs.addRow(['Average Lead Time (hours)', overall.AvgLeadTimeHours != null ? Number(overall.AvgLeadTimeHours).toFixed(1) : '—']);
    summaryWs.getRow(4).font = { bold: true };
    summaryWs.getRow(5).font = { bold: true };
    summaryWs.getRow(6).font = { bold: true };
    summaryWs.getRow(7).font = { bold: true };

    const byMaterialWs = wb.addWorksheet('By Material');
    byMaterialWs.columns = [
      { header: 'Material',       key: 'material',   width: 16 },
      { header: 'Description',    key: 'text',        width: 40 },
      { header: 'Completed',      key: 'count',        width: 12 },
      { header: 'On-Time',        key: 'onTime',         width: 10 },
      { header: 'On-Time %',      key: 'onTimePct',       width: 12 },
      { header: 'Avg Lead (hrs)', key: 'avgLead',           width: 14 },
    ];
    byMaterialWs.getRow(1).font = { bold: true };
    byMaterial.forEach(m => {
      const pct = m.CompletedCount ? (100 * m.OnTimeCount / m.CompletedCount) : 0;
      byMaterialWs.addRow({
        material: m.Material,
        text: m.MaterialText || '',
        count: m.CompletedCount,
        onTime: m.OnTimeCount,
        onTimePct: `${pct.toFixed(1)}%`,
        avgLead: m.AvgLeadTimeHours != null ? Number(m.AvgLeadTimeHours).toFixed(1) : '—',
      });
    });

    const detailWs = wb.addWorksheet('Requests');
    detailWs.columns = [
      { header: 'Request ID',   key: 'id',        width: 10 },
      { header: 'Material',     key: 'material',   width: 16 },
      { header: 'Description',  key: 'text',         width: 32 },
      { header: 'Qty Requested', key: 'qtyReq',        width: 14 },
      { header: 'Qty Delivered', key: 'qtyDel',          width: 14 },
      { header: 'Location',       key: 'location',         width: 20 },
      { header: 'Status',           key: 'status',            width: 12 },
      { header: 'Requested By',       key: 'reqBy',              width: 16 },
      { header: 'Requested At',         key: 'reqAt',               width: 20 },
      { header: 'Due At',                 key: 'dueAt',                width: 20 },
      { header: 'Completed At',             key: 'compAt',               width: 20 },
      { header: 'On Time',                    key: 'onTime',                width: 10 },
    ];
    detailWs.getRow(1).font = { bold: true };
    requests.forEach(r => {
      detailWs.addRow({
        id: r.RequestId,
        material: r.Material,
        text: r.MaterialText || '',
        qtyReq: Number(r.QuantityRequested),
        qtyDel: Number(r.QuantityDelivered),
        location: r.Location,
        status: r.Status,
        reqBy: r.RequestedBy,
        reqAt: r.RequestedAtUtc ? new Date(r.RequestedAtUtc).toISOString().slice(0, 16).replace('T', ' ') : '',
        dueAt: r.DueAtUtc ? new Date(r.DueAtUtc).toISOString().slice(0, 16).replace('T', ' ') : '',
        compAt: r.CompletedAtUtc ? new Date(r.CompletedAtUtc).toISOString().slice(0, 16).replace('T', ' ') : '',
        onTime: r.Status === 'Completed' ? (new Date(r.CompletedAtUtc) <= new Date(r.DueAtUtc) ? 'Yes' : 'No') : '',
      });
    });

    const filename = `staging_post_kpi_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[staging/kpi/export]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: { message: err.message } });
    }
  }
});

// ── Bin restrictions (Warehouse Supervisor config, LOG_SUPER-gated writes) ───

router.get('/bin-restrictions', async (req, res) => {
  try {
    const data = await db.listBinRestrictions();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/bin-restrictions', requirePermission('LOG_SUPER'), async (req, res) => {
  try {
    const { material, storageType } = req.body;
    if (!material || !String(material).trim()) {
      return res.status(400).json({ success: false, error: { message: 'material is required.' } });
    }
    if (!storageType || !String(storageType).trim()) {
      return res.status(400).json({ success: false, error: { message: 'storageType is required.' } });
    }
    const restrictionId = await db.createBinRestriction({ ...req.body, createdBy: actor(req) });
    res.json({ success: true, data: { restrictionId } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.put('/bin-restrictions/:id', requirePermission('LOG_SUPER'), async (req, res) => {
  try {
    const { material, storageType } = req.body;
    if (!material || !String(material).trim()) {
      return res.status(400).json({ success: false, error: { message: 'material is required.' } });
    }
    if (!storageType || !String(storageType).trim()) {
      return res.status(400).json({ success: false, error: { message: 'storageType is required.' } });
    }
    await db.updateBinRestriction(req.params.id, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.delete('/bin-restrictions/:id', requirePermission('LOG_SUPER'), async (req, res) => {
  try {
    await db.deleteBinRestriction(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export default router;
