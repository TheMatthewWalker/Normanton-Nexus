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
import { sapConfig, sapServerSecret, sqlConfig } from '../config.js';
import { requirePermission } from '../middleware/auth.js';
import * as db from './stagingsql.js';

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
  return body.data;
}

// SapServer's existing POST /api/warehouse/transfer-order (L_TO_CREATE_SINGLE) —
// same endpoint private/js/warehouse.js's Stock Transfer tool already uses.
async function createSapTransferOrder(body) {
  const response = await axios.post(`${sapConfig.url}/api/warehouse/transfer-order`, body, {
    timeout: 60000,
    httpsAgent: sapAgent,
    headers: { Authorization: `Bearer ${makeSapToken()}` },
  });
  const responseBody = response.data;
  if (!responseBody.success) throw new Error(responseBody.error ?? 'SapServer returned success=false');
  return responseBody.data;
}

// Minimum lead time a production request can specify — protects Stores from
// being asked for an impossible immediate turnaround. No upper bound.
const NEEDED_BY_MIN_LEAD_HOURS = 4;

// ── Material search (no LOG_MRP gate — see stagingsql.js's searchMaterials) ──

router.get('/materials', async (req, res) => {
  try {
    const { search } = req.query;
    if (!search || !String(search).trim()) return res.json({ success: true, data: [] });
    const data = await db.searchMaterials(search);
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
    const { material, materialText, uom, quantityRequested, location, requestedBatch, dueAtUtc, notes } = req.body;

    if (!material || !String(material).trim()) {
      return res.status(400).json({ success: false, error: { message: 'material is required.' } });
    }
    if (!(Number(quantityRequested) > 0)) {
      return res.status(400).json({ success: false, error: { message: 'quantityRequested must be greater than zero.' } });
    }
    if (!location || !String(location).trim()) {
      return res.status(400).json({ success: false, error: { message: 'location is required.' } });
    }
    if (!dueAtUtc) {
      return res.status(400).json({ success: false, error: { message: 'dueAtUtc (Needed By) is required.' } });
    }
    const due = new Date(dueAtUtc);
    const minDue = new Date(Date.now() + NEEDED_BY_MIN_LEAD_HOURS * 60 * 60 * 1000);
    if (due < minDue) {
      return res.status(400).json({
        success: false,
        error: { message: `Needed By must be at least ${NEEDED_BY_MIN_LEAD_HOURS} hours from now.` },
      });
    }

    const requestedBy = actor(req);
    const requestId = await db.createStagingRequest({
      material, materialText, uom, quantityRequested, location, requestedBatch, dueAtUtc: due, notes, requestedBy,
    });
    await audit('STAGING_REQUEST_CREATED', requestedBy, `Request #${requestId} — ${quantityRequested} of ${material} to ${location}`, req);
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

    let transferOrder;
    try {
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
    } catch (sapErr) {
      await audit('STAGING_DELIVER_SAP_ERROR', actor(req), `Request #${req.params.id} — ${sapErr.message}`, req);
      return res.status(422).json({ success: false, error: { message: `SAP rejected the transfer order: ${sapErr.message}` } });
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

    res.json({
      success: true,
      data: {
        transferOrderNumber: transferOrder.transferOrderNumber,
        messages: transferOrder.messages || [],
        ...result,
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
