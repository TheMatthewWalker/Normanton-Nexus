// routes/stockcount.js
//
// Stock Count feature — Weekly PTFE Cycle Count, Full Warehouse Raw Material
// Scan, Production Count, Finished Goods Count. See the approved Stock Count
// plan and migrations/nexus_operations/20260814120000_stock_count.cjs for
// the schema/workflow writeup.
//
// Owns its own makeSapToken/sapAgent/audit boilerplate rather than importing
// from routes/sap.js — same per-file convention as staging.js/
// productionnexus.js/quality.js.
//
// This file covers material validation/fuzzy-match, count entry (material/
// qty/free-typed storage type+bin, compared live against SAP LQUA — PTFE's
// bin is validated against SAP LAGP at entry time, same as Raw Material's),
// the Invalid Materials correction flow, Raw Material bin completion, the
// submit -> finance-approve/reject -> 711/712-post pipeline shared by
// PTFE_WEEKLY/RAW_MATERIAL/PRODUCTION counts, and Finished Goods Count's
// guided scan flow + discrepancy resolution (a separate pipeline — no
// approval/posting; mismatches move via Transfer Order, not a 711/712).

import express from 'express';
import axios   from 'axios';
import https   from 'https';
import fs      from 'fs';
import jwt     from 'jsonwebtoken';
import sql     from 'mssql';
import { sapConfig, sapServerSecret, getNexusPool } from '../config.js';
import { requirePermission } from '../middleware/auth.js';
import { notify } from '../lib/notify.js';
import * as db from './stockcountsql.js';

const router = express.Router();

// ── SAP caller ──────────────────────────────────────────────────────────────
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
    console.error('[stockcount audit]', err.message);
  }
}

function actor(req) {
  return req.session?.user?.username || 'unknown';
}

// Same semantics as middleware/auth.js's requirePermission, used inline
// rather than as route middleware where the gate depends on the request
// body/loaded document rather than being uniform for the whole route (e.g.
// closing a RAW_MATERIAL/PRODUCTION count is supervisor-only, but PTFE's
// isn't — both go through the same POST /counts/:id/submit route).
function hasPermission(req, code) {
  const user = req.session?.user;
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  return Array.isArray(user.permissions) && user.permissions.includes(code);
}

// Reuses the existing GET /api/warehouse/bin-storage-types (LAGP lookup, no
// SapServer change needed) to validate a free-typed storage type/bin (PTFE
// Weekly Cycle Count line entry) — a bin that isn't registered in LAGP at
// all comes back with an empty array; a bin that exists but under a
// different storage type comes back with that type missing from the array.
async function binHasStorageType(bin, storageType) {
  const response = await axios.get(`${sapConfig.url}/api/warehouse/bin-storage-types`, {
    params: { bin },
    timeout: 30000,
    httpsAgent: sapAgent,
    headers: { Authorization: `Bearer ${makeSapToken()}` },
  });
  const body = response.data;
  if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');
  return (body.data || []).includes(storageType);
}

// ── Material lookup ──────────────────────────────────────────────────────────

router.get('/materials', async (req, res) => {
  const { search } = req.query;
  if (!search) return res.status(400).json({ success: false, error: 'search is required' });
  try {
    const rows = await db.searchMaterialsForCount(search);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/materials/:material/validate', async (req, res) => {
  try {
    const match = await db.searchMaterialForCount(req.params.material);
    if (match) return res.json({ success: true, data: { valid: true, ...match } });
    const suggestions = await db.fuzzyMatchMaterial(req.params.material);
    res.json({ success: true, data: { valid: false, suggestions } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── SAP stock lookup (comparison source for line entry) ──────────────────────

async function fetchSapStock({ material, storageType, bin, storageLocation, excludeStorageType }) {
  const response = await axios.get(`${sapConfig.url}/api/warehouse/stock`, {
    params: { material, storageType, bin, storageLocation, excludeStorageType, rowCount: 9999 },
    timeout: 30000,
    httpsAgent: sapAgent,
    headers: { Authorization: `Bearer ${makeSapToken()}` },
  });
  const body = response.data;
  if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');
  return body.data || [];
}

// MARD-based (inventory-managed-only) stock — storage location 1716
// (Production Count) has no WM/bin concept and never appears in LQUA,
// confirmed against the real SAP system; see SapServer's
// WarehouseHelpers.BuildImStockRequest/GetImStock.
async function fetchSapImStock({ material, storageLocation }) {
  const response = await axios.get(`${sapConfig.url}/api/warehouse/im-stock`, {
    params: { material, storageLocation, rowCount: 9999 },
    timeout: 30000,
    httpsAgent: sapAgent,
    headers: { Authorization: `Bearer ${makeSapToken()}` },
  });
  const body = response.data;
  if (!body.success) throw new Error(body.error ?? 'SapServer returned success=false');
  return body.data || [];
}

function sumQty(rows) {
  return rows.reduce((sum, r) => sum + (Number(r.availableQty) || 0), 0);
}

// Resolves the SAP comparison quantity (and, for Production Count, whether
// the material turns out to be batch-managed) for one count line, branching
// on the document's CountType — the three ways this feature compares a
// counted line against SAP:
//   PTFE_WEEKLY  — operator-entered (free-typed, not a supervisor-maintained
//                  map) storage type/bin, validated against SAP LAGP before
//                  this is ever called (see the PUT.../lines check below),
//                  LGTYP 'SA' excluded (that bin type holds material already
//                  issued to production, not real countable raw-material
//                  stock).
//   RAW_MATERIAL — operator-entered storage type/bin, scoped to the count's
//                  storage location (1710). Storage type 'SA' is rejected
//                  outright (see the 400 check in POST /counts/:id/lines)
//                  for the same reason PTFE excludes it.
//   PRODUCTION   — storage location 1716 is inventory-managed only (MARD,
//                  confirmed against the real SAP system — LQUA never has
//                  1716 rows). Material issued to production also
//                  physically sits in storage type 'SA'/bin 'PTFE' under
//                  storage location 1710 (WM-managed) — the comparison sums
//                  MARD@1716 + LQUA@1710/SA/PTFE for this reason. Batch-
//                  managed detection is a separate, broader LQUA lookup (any
//                  location) since a batch-managed material may have zero
//                  stock in either of those two specific places right now —
//                  see StockAdjustmentModels.cs's StorageType doc comment in
//                  SapServer for the matching posting-side note.
async function resolveSapComparisonForLine(doc, { material, storageType, bin }) {
  if (doc.CountType === 'PTFE_WEEKLY') {
    const rows = await fetchSapStock({ material, storageType, bin, excludeStorageType: 'SA' });
    return {
      sapQty: sumQty(rows),
      storageType, bin, isBatchManaged: false,
    };
  }

  if (doc.CountType === 'RAW_MATERIAL') {
    const rows = await fetchSapStock({ material, storageType, bin, storageLocation: doc.StorageLocation });
    return {
      sapQty: sumQty(rows),
      storageType, bin, isBatchManaged: false,
    };
  }

  if (doc.CountType === 'PRODUCTION') {
    const [mardRows, saRows, anyLquaRows] = await Promise.all([
      fetchSapImStock({ material, storageLocation: doc.StorageLocation }),
      fetchSapStock({ material, storageType: 'SA', bin: 'PTFE', storageLocation: '1710' }),
      fetchSapStock({ material }),
    ]);
    return {
      sapQty: sumQty(mardRows) + sumQty(saRows),
      storageType: null, bin: null,
      isBatchManaged: anyLquaRows.some(r => r.batch && String(r.batch).trim() !== ''),
    };
  }

  throw new Error(`Unsupported count type for line entry: ${doc.CountType}`);
}

// ── Count documents — reads ──────────────────────────────────────────────────

router.get('/counts', async (req, res) => {
  try {
    const rows = await db.listCountDocuments({ countType: req.query.type, status: req.query.status });
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// This week's Monday, date-only — matches WeekStartDate's DATE column.
function mostRecentMonday(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d;
}

// Lazily creates the current week's PTFE count if the Monday 05:56 cron
// hasn't fired yet (or was missed) — the cron is a convenience pre-warm,
// this is the actual source of truth. See server.js's checkWeeklyPtfeCycleCountDue.
// Registered ahead of GET /counts/:id below — Express matches routes in
// registration order, and "current-ptfe" would otherwise be captured as
// the :id parameter.
router.get('/counts/current-ptfe', async (req, res) => {
  try {
    const { countId } = await db.getOrCreatePtfeCountForWeek(mostRecentMonday());
    const doc = await db.getCountDocument(countId);
    const lines = await db.listCountLines(countId);
    res.json({ success: true, data: { ...doc, lines } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/counts/:id', async (req, res) => {
  try {
    const doc = await db.getCountDocument(req.params.id);
    if (!doc) return res.status(404).json({ success: false, error: 'Count not found' });
    const lines = await db.listCountLines(req.params.id);
    res.json({ success: true, data: { ...doc, lines } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/counts/:id/report', async (req, res) => {
  try {
    const groupBy = req.query.groupBy === 'bin' ? 'bin' : 'material';
    const rows = groupBy === 'bin'
      ? await db.getCountReportByMaterialAndBin(req.params.id)
      : await db.getCountReportByMaterial(req.params.id);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Remediation for counts with lines entered before the group-variance fix
// (multiple lines for the same material/bin each compared independently
// against the same full SAP quantity — see addCountLine's header comment in
// stockcountsql.js for the exact bug and its fix). Re-derives every line's
// variance from what's already stored, no live SAP calls — safe to re-run.
router.post('/counts/:id/recompute', requirePermission('LOG_SUPER'), async (req, res) => {
  try {
    const doc = await db.getCountDocument(req.params.id);
    if (!doc) return res.status(404).json({ success: false, error: 'Count not found' });

    const result = await db.recomputeGroupVariances(req.params.id);
    await audit('STOCKCOUNT_OK', actor(req), `Count #${req.params.id} variances recomputed (${result.groupCount} group(s), ${result.lineCount} line(s))`, req);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Historical reports (across every count) ───────────────────────────────────

router.get('/reports/finance', requirePermission('FIN_STOCK_APPROVE'), async (req, res) => {
  try {
    const data = await db.getFinanceReport({ from: req.query.from, to: req.query.to });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/reports/warehouse-accuracy', requirePermission('LOG_SUPER'), async (req, res) => {
  try {
    const data = await db.getWarehouseAccuracyReport({ from: req.query.from, to: req.query.to });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Count documents — supervisor-initiated (Raw Material / Production) ───────

router.post('/counts', requirePermission('LOG_SUPER'), async (req, res) => {
  const { countType, storageLocation } = req.body;
  if (!['RAW_MATERIAL', 'PRODUCTION'].includes(countType)) {
    return res.status(400).json({ success: false, error: "countType must be 'RAW_MATERIAL' or 'PRODUCTION'" });
  }
  if (!storageLocation) return res.status(400).json({ success: false, error: 'storageLocation is required' });

  try {
    const countId = await db.createCountDocument({
      countType, storageLocation,
      createdBy: actor(req), createdByUserId: req.session.user.userID,
    });
    await audit('STOCKCOUNT_OK', actor(req), `${countType} count #${countId} started (storage location ${storageLocation})`, req);
    res.json({ success: true, data: { countId } });
  } catch (err) {
    await audit('STOCKCOUNT_ERROR', actor(req), `Failed to start ${countType} count: ${err.message}`, req);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Count lines ────────────────────────────────────────────────────────────────

router.post('/counts/:id/lines', async (req, res) => {
  const countId = req.params.id;
  const { material, storageType, bin, ticketNumber, countedQty } = req.body;
  if (!material || countedQty === undefined || countedQty === null) {
    return res.status(400).json({ success: false, error: 'material and countedQty are required' });
  }

  try {
    const doc = await db.getCountDocument(countId);
    if (!doc) return res.status(404).json({ success: false, error: 'Count not found' });
    if (doc.Status !== 'Open') return res.status(400).json({ success: false, error: `Count is ${doc.Status}, not open for entry` });

    // Storage type 'SA' holds material already issued to production, not
    // real raw-material warehouse stock — it's excluded from PTFE's
    // comparison automatically (ExcludeStorageType) but Raw Material Count
    // takes an operator-entered bin directly, so reject it outright here
    // rather than silently comparing against a bin that was never really
    // "raw material" in the first place.
    if (doc.CountType === 'RAW_MATERIAL' && String(storageType || '').toUpperCase() === 'SA') {
      return res.status(400).json({ success: false, error: "Storage type 'SA' holds material already issued to production — it doesn't belong in a Raw Material Count." });
    }

    // PTFE Weekly Cycle Count takes a free-typed bin (no supervisor-
    // maintained location map) — validated live against SAP LAGP here,
    // independent of material validity, so a typo'd bin is caught
    // immediately rather than silently producing a nonsense variance.
    if (doc.CountType === 'PTFE_WEEKLY') {
      if (!storageType || !bin) {
        return res.status(400).json({ success: false, error: 'storageType and bin are required' });
      }
      const exists = await binHasStorageType(String(bin).trim(), storageType);
      if (!exists) {
        return res.status(422).json({
          success: false,
          error: `Bin ${storageType}/${bin} was not found in SAP (LAGP) — check the storage type and bin and try again.`,
        });
      }
    }

    const materialInfo = await db.searchMaterialForCount(material);
    const isInvalidMaterial = !materialInfo;

    let sapQty = null, resolvedStorageType = storageType || null, resolvedBin = bin || null, isBatchManaged = false;
    let cumulativeCountedQty = Number(countedQty);
    let siblingLineIds = [];

    if (!isInvalidMaterial) {
      const comparison = await resolveSapComparisonForLine(doc, { material, storageType, bin });
      sapQty = comparison.sapQty;
      resolvedStorageType = comparison.storageType;
      resolvedBin = comparison.bin;
      isBatchManaged = comparison.isBatchManaged;

      // Fold this line into any existing lines already entered for the same
      // (Material, StorageType, Bin) in this count — comparing each line
      // independently against the full SAP quantity was a real bug: two
      // lines of 12,000kg for the same material/bin both showed "matched"
      // against SAP's one 12,000kg, and a third 6,000kg line then showed a
      // spurious 6,000kg *shortfall* instead of the ~18,000kg *surplus* the
      // three lines actually represented together. Only the newest line in
      // a group carries the group's live variance at any moment — see
      // addCountLine's header comment in stockcountsql.js.
      const siblings = await db.getGroupSiblingLines(countId, material, resolvedStorageType, resolvedBin);
      const priorTotal = siblings.reduce((sum, s) => sum + Number(s.CountedQty), 0);
      cumulativeCountedQty = priorTotal + Number(countedQty);
      siblingLineIds = siblings.map(s => s.LineId);
    }

    const lineId = await db.addCountLine(countId, {
      material,
      materialText: materialInfo?.materialText,
      uom: materialInfo?.uom,
      storageType: resolvedStorageType,
      bin: resolvedBin,
      // Per-line, not per-count — every physical lot on paper gets its own
      // ticket + label (RAW_MATERIAL/PRODUCTION only; ignored for PTFE/left
      // undefined by the frontend there).
      ticketNumber,
      countedQty: Number(countedQty),
      cumulativeCountedQty,
      sapQty,
      unitPrice: materialInfo?.unitPrice ?? null,
      isInvalidMaterial,
      isBatchManaged,
      enteredBy: actor(req),
    });

    if (siblingLineIds.length) await db.zeroLineVariances(siblingLineIds);

    res.json({
      success: true,
      data: {
        lineId, isInvalidMaterial, isBatchManaged,
        materialText: materialInfo?.materialText ?? null,
        uom: materialInfo?.uom ?? null,
        sapQty,
        redirectToFinishedGoodsCount: doc.CountType === 'PRODUCTION' && isBatchManaged,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/counts/:id/invalid-lines', async (req, res) => {
  try {
    const lines = await db.listInvalidLines(req.params.id);
    const withSuggestions = await Promise.all(lines.map(async (line) => ({
      ...line,
      suggestions: await db.fuzzyMatchMaterial(line.Material),
    })));
    res.json({ success: true, data: withSuggestions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Inline correct-and-clear — resolves the new material against the snapshot
// again (it must actually validate, or this would just swap one invalid
// code for another), runs the now-known-valid material through the same
// SAP comparison + group-variance folding as a freshly-added line (see
// POST /counts/:id/lines above and addCountLine's header comment) rather
// than just clearing the invalid flag and leaving SapQty/Variance at their
// insert-time NULLs forever — that used to silently exclude every corrected
// line from reports/finance totals.
router.put('/counts/:id/invalid-lines/:lineId', async (req, res) => {
  const { material } = req.body;
  if (!material) return res.status(400).json({ success: false, error: 'material is required' });

  try {
    const line = await db.getCountLineById(req.params.lineId);
    if (!line) return res.status(404).json({ success: false, error: 'Line not found' });

    const doc = await db.getCountDocument(line.CountId);
    if (!doc) return res.status(404).json({ success: false, error: 'Count not found' });

    const materialInfo = await db.searchMaterialForCount(material);
    if (!materialInfo) {
      return res.status(422).json({ success: false, error: `"${material}" does not validate against the material master either.` });
    }

    const comparison = await resolveSapComparisonForLine(doc, { material, storageType: line.StorageType, bin: line.Bin });
    const siblings = await db.getGroupSiblingLines(line.CountId, material, comparison.storageType, comparison.bin, line.LineId);
    const priorTotal = siblings.reduce((sum, s) => sum + Number(s.CountedQty), 0);
    const cumulativeCountedQty = priorTotal + Number(line.CountedQty);

    const updated = await db.correctInvalidMaterialLine(req.params.lineId, {
      material: materialInfo.material,
      materialText: materialInfo.materialText,
      uom: materialInfo.uom,
      unitPrice: materialInfo.unitPrice,
      isInvalidMaterial: false,
      countedQty: Number(line.CountedQty),
      cumulativeCountedQty,
      sapQty: comparison.sapQty,
      isBatchManaged: comparison.isBatchManaged,
    });
    if (!updated) return res.status(404).json({ success: false, error: 'Line not found' });

    if (siblings.length) await db.zeroLineVariances(siblings.map(s => s.LineId));

    await audit('STOCKCOUNT_OK', actor(req), `Count line #${req.params.lineId} corrected to material ${materialInfo.material}`, req);
    res.json({ success: true, data: { lineId: req.params.lineId, material: materialInfo.material } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/counts/:id/bins/:storageType/:bin/complete', requirePermission('LOG_SUPER'), async (req, res) => {
  try {
    const ok = await db.markBinComplete(req.params.id, req.params.storageType, req.params.bin, actor(req));
    if (!ok) return res.status(404).json({ success: false, error: 'No matching open bin line found' });
    res.json({ success: true, data: {} });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Submit / approve / reject ─────────────────────────────────────────────────

// Closing (submitting) a count is a supervisor action for RAW_MATERIAL/
// PRODUCTION — these are supervisor-initiated counts in the first place
// (POST /counts is already LOG_SUPER-gated), and operators entering lines
// shouldn't also be the ones deciding a count is finished. PTFE_WEEKLY is
// deliberately left open to any operator — it's cron-created, not
// supervisor-initiated, and doesn't need the same gatekeeping.
router.post('/counts/:id/submit', async (req, res) => {
  const countId = req.params.id;
  try {
    const doc = await db.getCountDocument(countId);
    if (!doc) return res.status(404).json({ success: false, error: 'Count not found' });
    if (doc.Status !== 'Open') return res.status(400).json({ success: false, error: `Count is already ${doc.Status}` });

    if ((doc.CountType === 'RAW_MATERIAL' || doc.CountType === 'PRODUCTION') && !hasPermission(req, 'LOG_SUPER')) {
      return res.status(403).json({ success: false, error: 'Requires permission: LOG_SUPER' });
    }

    if (await db.countHasInvalidLines(countId)) {
      return res.status(422).json({ success: false, error: 'This count has invalid material lines that must be corrected before it can be submitted.' });
    }
    if (doc.CountType === 'RAW_MATERIAL' && await db.countHasIncompleteBins(countId)) {
      return res.status(422).json({ success: false, error: 'All bins must be marked complete before this count can be submitted.' });
    }

    await db.updateCountStatus(countId, 'PendingApproval', { submittedBy: actor(req) });

    const nexusPool = await getNexusPool();
    notify(nexusPool, {
      title: `Stock Count #${countId} (${doc.CountType}) pending approval`,
      body: `A ${doc.CountType.replace('_', ' ').toLowerCase()} stock count has been submitted and needs finance approval.`,
      category: 'finance',
      actionLabel: 'Review in Stock Adjustments',
      actionURL: '/private/finance.html',
      target: { type: 'permission', value: 'FIN_STOCK_APPROVE' },
      createdByUserID: 0,
    }).catch(() => {});

    await audit('STOCKCOUNT_OK', actor(req), `Count #${countId} (${doc.CountType}) submitted for approval`, req);
    res.json({ success: true, data: { countId } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Posts one 711 (gain) or 712 (loss) BAPI_GOODSMVT_CREATE call per
// non-zero-variance line via SapServer's existing stock-adjustment endpoint
// (same one the Stock Investigations tile already uses), Promise.all with
// per-line results — mirrors productionnexus.js's /scrap/approve. Only
// gated to PendingApproval, not PendingApproval-or-Approved: without a
// per-line Posted flag, re-running this on a partially-failed Approved count
// would double-post the lines that already succeeded, so a partial failure
// currently requires manual follow-up (visible in the returned per-line
// results) rather than an automatic retry — a per-line PostedAtUtc column
// would be needed to make retry safe, deferred for now.
router.post('/counts/:id/approve', requirePermission('FIN_STOCK_APPROVE'), async (req, res) => {
  const countId = req.params.id;
  try {
    const doc = await db.getCountDocument(countId);
    if (!doc) return res.status(404).json({ success: false, error: 'Count not found' });
    if (doc.Status !== 'PendingApproval') {
      return res.status(400).json({ success: false, error: `Count is ${doc.Status}, not pending approval` });
    }

    const lines = await db.listCountLines(countId);
    const postable = lines.filter(l => l.VarianceQty !== null && Number(l.VarianceQty) !== 0);

    const results = await Promise.all(postable.map(async (line) => {
      const movementType = Number(line.VarianceQty) > 0 ? '711' : '712';
      const body = {
        Material: line.Material,
        StorageLocation: doc.StorageLocation,
        // Production Count lines have no StorageType/Bin (no WM concept at
        // 1716) — falls back to the SA/PTFE convention documented on
        // StockAdjustmentModels.StorageType, still unverified against a
        // real SAP system (see that file's caveat).
        StorageType: line.StorageType || 'SA',
        StorageBin: line.Bin || 'PTFE',
        MovementType: movementType,
        Quantity: Math.abs(Number(line.VarianceQty)),
        Unit: line.Uom || '',
        Reference: `StockCount${countId}`,
      };
      try {
        const response = await axios.post(`${sapConfig.url}/api/warehouse/stock-adjustment`, body, {
          timeout: 60000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` },
        });
        const respBody = response.data;
        if (!respBody.success) throw new Error(respBody.error ?? 'SapServer returned success=false');
        return { lineId: line.LineId, material: line.Material, movementType, success: true };
      } catch (err) {
        return { lineId: line.LineId, material: line.Material, movementType, success: false, error: err.response?.data?.error ?? err.message };
      }
    }));

    const allSucceeded = results.every(r => r.success);

    await db.updateCountStatus(countId, 'Approved', { approvedBy: actor(req) });
    if (allSucceeded) {
      await db.updateCountStatus(countId, 'Posted', { postedByUserId: req.session.user.userID });
    }

    await audit(
      allSucceeded ? 'STOCKCOUNT_OK' : 'STOCKCOUNT_ERROR',
      actor(req),
      `Count #${countId} approved — ${results.filter(r => r.success).length}/${results.length} adjustments posted`,
      req,
    );
    res.json({ success: true, data: { results, allSucceeded, postedLineCount: postable.length } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/counts/:id/reject', requirePermission('FIN_STOCK_APPROVE'), async (req, res) => {
  const countId = req.params.id;
  const { reason } = req.body;
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ success: false, error: 'A rejection reason is required.' });
  }

  try {
    const doc = await db.getCountDocument(countId);
    if (!doc) return res.status(404).json({ success: false, error: 'Count not found' });
    if (doc.Status !== 'PendingApproval') {
      return res.status(400).json({ success: false, error: `Count is ${doc.Status}, not pending approval` });
    }

    await db.updateCountStatus(countId, 'Rejected', { rejectedBy: actor(req), rejectionReason: reason });

    const nexusPool = await getNexusPool();
    notify(nexusPool, {
      title: `Stock Count #${countId} (${doc.CountType}) rejected`,
      body: reason,
      category: 'warehouse',
      actionLabel: 'Reopen count',
      actionURL: '/private/warehouse.html',
      target: { type: 'permission', value: 'LOG_SUPER' },
      createdByUserID: 0,
    }).catch(() => {});

    await audit('STOCKCOUNT_OK', actor(req), `Count #${countId} rejected: ${reason}`, req);
    res.json({ success: true, data: { countId } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Re-opens a rejected count so the warehouse supervisor can correct it and
// resubmit — separate from reject itself (which only ever moves
// PendingApproval -> Rejected) so Rejected stays a distinct, visible state
// in the finance approval list rather than silently reverting straight to Open.
router.post('/counts/:id/reopen', requirePermission('LOG_SUPER'), async (req, res) => {
  const countId = req.params.id;
  try {
    const doc = await db.getCountDocument(countId);
    if (!doc) return res.status(404).json({ success: false, error: 'Count not found' });
    if (doc.Status !== 'Rejected') {
      return res.status(400).json({ success: false, error: `Count is ${doc.Status}, not rejected` });
    }

    await db.updateCountStatus(countId, 'Open', { reopenedBy: actor(req) });
    await audit('STOCKCOUNT_OK', actor(req), `Count #${countId} reopened for correction`, req);
    res.json({ success: true, data: { countId } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Finished Goods Count — session ────────────────────────────────────────────
//
// Reuses log.StockCountDocument as a pure active-session marker
// (CountType='FINISHED_GOODS', no lines/approval fields populated) so the
// transfer-request guard has one consistent table to check across all four
// count types — see lib/stockCountGuard.js and the migration's header
// comment. Starting a session immediately engages the guard for its
// storageLocation; ending it lifts the block.

router.get('/fg/session/current', async (req, res) => {
  try {
    const session = await db.getActiveFgSession();
    res.json({ success: true, data: session });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/fg/session/start', requirePermission('LOG_SUPER'), async (req, res) => {
  const { storageLocation } = req.body;
  if (!storageLocation) return res.status(400).json({ success: false, error: 'storageLocation is required' });

  try {
    const existing = await db.getActiveFgSession();
    if (existing) {
      return res.status(400).json({ success: false, error: `A Finished Goods Count session (#${existing.CountId}) is already open.` });
    }
    const countId = await db.createCountDocument({
      countType: 'FINISHED_GOODS', storageLocation, createdBy: actor(req), createdByUserId: req.session.user.userID,
    });
    await audit('STOCKCOUNT_OK', actor(req), `Finished Goods Count session #${countId} started (storage location ${storageLocation})`, req);
    res.json({ success: true, data: { countId } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/fg/session/:id/end', requirePermission('LOG_SUPER'), async (req, res) => {
  try {
    const doc = await db.getCountDocument(req.params.id);
    if (!doc || doc.CountType !== 'FINISHED_GOODS') return res.status(404).json({ success: false, error: 'Session not found' });
    if (doc.Status !== 'Open') return res.status(400).json({ success: false, error: `Session is already ${doc.Status}` });

    // Reuses the SubmittedBy/SubmittedAtUtc columns to record who closed the
    // session — those fields are otherwise unused for CountType='FINISHED_GOODS'.
    await db.updateCountStatus(req.params.id, 'Closed', { submittedBy: actor(req) });
    await audit('STOCKCOUNT_OK', actor(req), `Finished Goods Count session #${req.params.id} ended`, req);
    res.json({ success: true, data: {} });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Finished Goods Count — batch download + guided scan ──────────────────────

router.get('/fg/batches', async (req, res) => {
  try {
    const session = await db.getActiveFgSession();
    if (!session) return res.status(400).json({ success: false, error: 'No Finished Goods Count session is currently open.' });

    const rows = await fetchSapStock({ storageLocation: session.StorageLocation });
    const batches = rows.filter(r => r.batch && String(r.batch).trim() !== '');
    res.json({ success: true, data: batches });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Scan outcome is judged against the exact scanned bin (does LQUA show this
// Material+Batch+StorageType+Bin combination) rather than a single "the
// expected bin" — a batch legitimately present in more than one bin is
// handled without special-case code this way, per the approved plan.
router.post('/fg/scan', async (req, res) => {
  const { material, batch, scannedStorageType, scannedBin } = req.body;
  if (!material || !batch || !scannedStorageType || !scannedBin) {
    return res.status(400).json({ success: false, error: 'material, batch, scannedStorageType and scannedBin are all required' });
  }

  try {
    const exactRows = await fetchSapStock({ material, batch, storageType: scannedStorageType, bin: scannedBin });
    const expectedFound = exactRows.length > 0;
    const outcome = expectedFound ? 'CorrectBin' : 'WrongBin';

    const scanId = await db.recordFgScan({
      material, batch, expectedFound, scannedStorageType, scannedBin, outcome, scannedBy: actor(req),
    });

    // Auto-resolve any prior open discrepancy for this batch — fresh scan
    // data supersedes it regardless of the current scan's own outcome.
    const openDiscrepancy = await db.findOpenDiscrepancy(material, batch);
    if (openDiscrepancy) {
      await db.resolveDiscrepancy(openDiscrepancy.DiscrepancyId, 'ResolvedFoundLater', { resolvedBy: actor(req) });
    }

    let expectedStorageType = null, expectedBin = null;
    if (outcome === 'WrongBin') {
      const anywhereRows = await fetchSapStock({ material, batch });
      if (anywhereRows.length) {
        expectedStorageType = anywhereRows[0].storageType;
        expectedBin = anywhereRows[0].bin;
      }
      await db.createDiscrepancy({
        material, batch, kind: 'WrongBin',
        expectedStorageType, expectedBin,
        foundStorageType: scannedStorageType, foundBin: scannedBin,
        sourceScanId: scanId,
      });

      const nexusPool = await getNexusPool();
      notify(nexusPool, {
        title: `Batch ${batch} scanned in the wrong bin`,
        body: `${material} / batch ${batch} was scanned in ${scannedStorageType}/${scannedBin}${expectedBin ? `, SAP expects it in ${expectedStorageType}/${expectedBin}` : ' — SAP has no record of it anywhere'}.`,
        category: 'warehouse',
        actionLabel: 'Review in Stock Investigations',
        actionURL: '/private/warehouse.html',
        target: { type: 'permission', value: 'LOG_SUPER' },
        createdByUserID: 0,
      }).catch(() => {});
    }

    res.json({ success: true, data: { scanId, outcome, expectedStorageType, expectedBin } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// "CONFIRM BIN fully scanned" — diffs LQUA's expected batches for this bin
// against what's actually been scanned as CorrectBin there, and creates a
// 'Missing' discrepancy (+ a matching MissingFromBin scan-audit row) for
// every gap.
router.post('/fg/bins/:storageType/:bin/confirm', async (req, res) => {
  const { storageType, bin } = req.params;
  try {
    const [expectedRows, confirmed] = await Promise.all([
      fetchSapStock({ storageType, bin }),
      db.listConfirmedBatchesInBin(storageType, bin),
    ]);

    const confirmedKeys = new Set(confirmed.map(c => `${c.Material}::${c.Batch}`));
    const expectedBatches = expectedRows.filter(r => r.batch && String(r.batch).trim() !== '');
    const missing = expectedBatches.filter(r => !confirmedKeys.has(`${r.material}::${r.batch}`));

    for (const row of missing) {
      const scanId = await db.recordFgScan({
        material: row.material, batch: row.batch, expectedFound: false,
        scannedStorageType: storageType, scannedBin: bin, outcome: 'MissingFromBin', scannedBy: actor(req),
      });
      await db.createDiscrepancy({
        material: row.material, batch: row.batch, kind: 'Missing',
        expectedStorageType: storageType, expectedBin: bin,
        sourceScanId: scanId,
      });
    }

    await audit('STOCKCOUNT_OK', actor(req), `Bin ${storageType}/${bin} confirmed fully scanned — ${missing.length} batch(es) missing`, req);
    res.json({ success: true, data: { missingCount: missing.length } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Finished Goods Count — discrepancy resolution (Stock Investigations'
// "Stock Count Discrepancies" panel) ─────────────────────────────────────────

router.get('/discrepancies', async (req, res) => {
  try {
    const rows = await db.listOpenDiscrepancies();
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Deliberately calls SapServer directly (not through /api/sap/warehouse/
// transfer-order) — these three actions exist specifically to resolve
// findings from the very Finished Goods Count session that would otherwise
// block general transfers for its storage location, so they must bypass
// lib/stockCountGuard.js's assertTransfersAllowed rather than trip it.
async function createSapTransferOrderDirect(body) {
  const response = await axios.post(`${sapConfig.url}/api/warehouse/transfer-order`, body, {
    timeout: 60000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` },
  });
  const respBody = response.data;
  if (!respBody.success) throw new Error(respBody.error ?? 'SapServer returned success=false');
  return respBody.data;
}

router.post('/discrepancies/:id/resolve-move', requirePermission('LOG_SUPER'), async (req, res) => {
  try {
    const disc = await db.getDiscrepancy(req.params.id);
    if (!disc || disc.Status !== 'Open') return res.status(404).json({ success: false, error: 'Open discrepancy not found' });
    if (disc.Kind !== 'WrongBin') return res.status(400).json({ success: false, error: 'Only WrongBin discrepancies can be mass-moved — use resolve-holding for Missing ones.' });

    const sourceRows = await fetchSapStock({ material: disc.Material, batch: disc.Batch, storageType: disc.ExpectedStorageType, bin: disc.ExpectedBin });
    if (!sourceRows.length) {
      return res.status(422).json({ success: false, error: `SAP no longer shows ${disc.Material}/${disc.Batch} in ${disc.ExpectedStorageType}/${disc.ExpectedBin} — it may have already moved.` });
    }

    const result = await createSapTransferOrderDirect({
      StorageLocation: sourceRows[0].storageLocation,
      Material: disc.Material,
      Batch: disc.Batch,
      Quantity: sourceRows[0].availableQty,
      SourceType: disc.ExpectedStorageType,
      SourceBin: disc.ExpectedBin,
      DestinationType: disc.FoundStorageType,
      DestinationBin: disc.FoundBin,
    });

    await db.resolveDiscrepancy(req.params.id, 'ResolvedMoved', { resolvedBy: actor(req), resolutionTransferOrderNumber: result?.transferOrderNumber });
    await audit('STOCKCOUNT_OK', actor(req), `Discrepancy #${req.params.id} resolved by moving ${disc.Material}/${disc.Batch} to ${disc.FoundStorageType}/${disc.FoundBin}`, req);
    res.json({ success: true, data: { transferOrderNumber: result?.transferOrderNumber } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/discrepancies/:id/resolve-holding', requirePermission('LOG_SUPER'), async (req, res) => {
  try {
    const disc = await db.getDiscrepancy(req.params.id);
    if (!disc || disc.Status !== 'Open') return res.status(404).json({ success: false, error: 'Open discrepancy not found' });

    const sourceRows = await fetchSapStock({ material: disc.Material, batch: disc.Batch, storageType: disc.ExpectedStorageType, bin: disc.ExpectedBin });
    if (!sourceRows.length) {
      return res.status(422).json({ success: false, error: `SAP no longer shows ${disc.Material}/${disc.Batch} in ${disc.ExpectedStorageType}/${disc.ExpectedBin} — it may have already moved.` });
    }

    const result = await createSapTransferOrderDirect({
      StorageLocation: sourceRows[0].storageLocation,
      Material: disc.Material,
      Batch: disc.Batch,
      Quantity: sourceRows[0].availableQty,
      SourceType: disc.ExpectedStorageType,
      SourceBin: disc.ExpectedBin,
      DestinationType: '999',
      DestinationBin: 'TEMP',
    });

    await db.resolveDiscrepancy(req.params.id, 'ResolvedHolding', { resolvedBy: actor(req), resolutionTransferOrderNumber: result?.transferOrderNumber });
    await audit('STOCKCOUNT_OK', actor(req), `Discrepancy #${req.params.id} resolved by moving ${disc.Material}/${disc.Batch} to holding (999/TEMP)`, req);
    res.json({ success: true, data: { transferOrderNumber: result?.transferOrderNumber } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manual TO without a prior scan — the supervisor already knows where the
// batch physically is (e.g. found it by eye) and just wants SAP corrected.
router.post('/discrepancies/:id/manual-to', requirePermission('LOG_SUPER'), async (req, res) => {
  const { destinationStorageType, destinationBin } = req.body;
  if (!destinationStorageType || !destinationBin) {
    return res.status(400).json({ success: false, error: 'destinationStorageType and destinationBin are required' });
  }

  try {
    const disc = await db.getDiscrepancy(req.params.id);
    if (!disc || disc.Status !== 'Open') return res.status(404).json({ success: false, error: 'Open discrepancy not found' });

    const sourceRows = await fetchSapStock({ material: disc.Material, batch: disc.Batch, storageType: disc.ExpectedStorageType, bin: disc.ExpectedBin });
    if (!sourceRows.length) {
      return res.status(422).json({ success: false, error: `SAP no longer shows ${disc.Material}/${disc.Batch} in ${disc.ExpectedStorageType}/${disc.ExpectedBin} — it may have already moved.` });
    }

    const result = await createSapTransferOrderDirect({
      StorageLocation: sourceRows[0].storageLocation,
      Material: disc.Material,
      Batch: disc.Batch,
      Quantity: sourceRows[0].availableQty,
      SourceType: disc.ExpectedStorageType,
      SourceBin: disc.ExpectedBin,
      DestinationType: destinationStorageType,
      DestinationBin: destinationBin,
    });

    await db.resolveDiscrepancy(req.params.id, 'ResolvedMoved', { resolvedBy: actor(req), resolutionTransferOrderNumber: result?.transferOrderNumber });
    await audit('STOCKCOUNT_OK', actor(req), `Discrepancy #${req.params.id} resolved via manual TO to ${destinationStorageType}/${destinationBin}`, req);
    res.json({ success: true, data: { transferOrderNumber: result?.transferOrderNumber } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Cron entry point (server.js, Mondays 05:56 — one minute after the
// existing hourly :55 job to avoid a same-minute collision with
// runSapSync()). Idempotent — see getOrCreatePtfeCountForWeek's own comment
// for why a missed/late run is safe; this is a convenience pre-warm, not the
// only creation path (GET /counts/current-ptfe also lazily creates it).
export async function checkWeeklyPtfeCycleCountDue() {
  const { countId, created } = await db.getOrCreatePtfeCountForWeek(mostRecentMonday());
  return { countId, created };
}

export { mostRecentMonday };
export default router;
