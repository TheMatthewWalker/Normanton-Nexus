// routes/mrpanalysis.js
//
// MRP Analysis — Logistics > Material Planning. Year-on-year consumption/goods-receipt
// trends per material (resolvable per vendor), and two ways to turn a sales outlook into a
// raw-material purchasing number for next year: a %-increase extrapolation against past
// consumption, or a full sales-unit breakdown exploded down through SAP's multi-level BOM to
// raw materials (SapServer's MrpAnalysisController). Kept as its own route file rather than
// added to routes/performance.js — that file is already large/actively-evolving (see its own
// CLAUDE.md note).
//
// Every forecast calculation (either method) is saved as an immutable, dated snapshot in
// log.MrpForecastRun — never overwritten, so estimates can be compared over time (see
// migrations/nexus_operations/20260817150000_mrp_analysis.cjs). Both methods follow the same
// preview-then-save shape: a preview endpoint computes/returns the result without writing
// anything, and a separate save endpoint (fed the previewed data back) is what actually
// creates the snapshot — this stops an exploratory calculation from silently creating a
// permanent run, and keeps the two methods symmetric.

import express from 'express';
import ExcelJS from 'exceljs';
import * as sap from './performancesap.js';
import * as db  from './performancesql.js';
import { runMrpHistoryRefresh } from './performancesync.js';
import { getNexusPool, auditQuery } from '../config.js';
import { requirePermission } from '../middleware/auth.js';

const router = express.Router();

// ── Trends ───────────────────────────────────────────────────────────────────
//
// materials/vendorId are both optional filters — omit either for "every material"/"every
// vendor". Consumption is vendor-agnostic (SAP doesn't attribute usage to whichever vendor
// happened to supply the material) so it's returned unfiltered by vendor even when vendorId
// is given; receipts are the vendor-resolvable series.

router.get('/trends', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const materials = Array.isArray(req.query.materials) ? req.query.materials
      : (req.query.materials ? [req.query.materials] : null);
    const vendorId = req.query.vendorId ? Number(req.query.vendorId) : null;

    const [consumption, receipts] = await Promise.all([
      db.getConsumptionByYear(materials),
      db.getReceiptHistoryByVendor(materials, vendorId),
    ]);

    res.json({ success: true, data: { consumption, receipts } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Manual history refresh ("Refresh Now" button) + status ─────────────────────
// Same pattern as routes/performance.js's /turns-valclass/refresh(-status).

router.post('/refresh', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const results = await runMrpHistoryRefresh(req);
    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/refresh-status', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const pool = await getNexusPool();
    const { recordset } = await pool.request().query(`
      SELECT TOP 1 Status, CompletedAtUtc, ErrorMessage, RunId
      FROM dbo.RefreshLog
      WHERE DatasetName = 'MrpAnalysisHistory'
      ORDER BY RunId DESC
    `);
    res.json({ success: true, data: recordset[0] || null });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Forecast — Percentage method ────────────────────────────────────────────
// Predicted qty = the material's ConsumedQty for baselineYear, extrapolated by
// percentageChange% — "using the percentage increase against the previous/current year's
// usage" per the user's own description of the feature. When baselineYear is the current,
// still-in-progress calendar year, ConsumedQty is only a year-to-date total — annualisationFactor/
// applyPercentage below annualise it to a full-year run rate first, so choosing this year as
// the baseline doesn't understate the prediction just because the year isn't finished yet.
// Preview only reads MaterialConsumptionHistory; save writes the snapshot the preview already
// showed the operator, not a fresh recompute (so what gets saved is exactly what was reviewed).

function daysInYear(year) {
  return ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) ? 366 : 365;
}

// 1 on Jan 1st, 365/366 on Dec 31st.
function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((today - start) / 86400000) + 1;
}

// log.MaterialConsumptionHistory.ConsumedQty for the CURRENT (still in progress) calendar
// year is a year-to-date total, not a full year's — see runMrpHistoryRefresh/
// SapServer.PerformanceHelpers.ParseConsumptionHistoryByYear, which sums MVER's GSV01..GSV12
// for whichever months have actually posted so far, nothing more. Applying "+X%" straight to
// that partial total would badly understate the following year's requirement (e.g. 8 months
// of data read as if it were the whole year). Only the current calendar year needs this —
// any other baseline year is already a complete, closed total. Guards the elapsed-days
// denominator at a minimum of 1 day so Jan 1st doesn't divide by zero / blow up the estimate.
//
// This assumes SAP's fiscal year (GJAHR, what FiscalYear actually is) lines up with the
// calendar year on this system — same caveat ParseConsumptionHistoryByYear's own comment
// already carries; there's no fiscal-year-start configured anywhere to do this properly if
// that's ever not true.
function annualisationFactor(baselineYear, now = new Date()) {
  if (Number(baselineYear) !== now.getUTCFullYear()) return 1;
  return daysInYear(now.getUTCFullYear()) / Math.max(dayOfYear(now), 1);
}

function applyPercentage(consumptionRows, baselineYear, percentageChange, now = new Date()) {
  const factor = 1 + (Number(percentageChange) || 0) / 100;
  const annualise = annualisationFactor(baselineYear, now);
  const isPartialYearBaseline = annualise !== 1;

  const materials = consumptionRows
    .filter(r => r.FiscalYear === Number(baselineYear))
    .map(r => {
      const actualQty = Number(r.ConsumedQty);
      const annualisedQty = actualQty * annualise;
      return {
        material:      r.Material,
        materialText:  r.MaterialText,
        actualQty:     Math.round(actualQty * 1000) / 1000,
        annualisedQty: isPartialYearBaseline ? Math.round(annualisedQty * 1000) / 1000 : null,
        predictedQty:  Math.round(annualisedQty * factor * 1000) / 1000,
        uom:           null,
      };
    });

  return { materials, isPartialYearBaseline };
}

router.post('/forecast/percentage', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { baselineYear, percentageChange, materials } = req.body || {};
    if (!baselineYear) return res.status(400).json({ success: false, error: { message: 'baselineYear is required.' } });
    if (percentageChange === undefined || percentageChange === null || Number.isNaN(Number(percentageChange))) {
      return res.status(400).json({ success: false, error: { message: 'percentageChange is required.' } });
    }

    const consumptionRows = await db.getConsumptionByYear(materials || null);
    const { materials: predicted, isPartialYearBaseline } = applyPercentage(consumptionRows, baselineYear, percentageChange);

    res.json({
      success: true,
      data: { baselineYear: Number(baselineYear), percentageChange: Number(percentageChange), isPartialYearBaseline, materials: predicted },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/forecast/percentage/save', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { targetYear, baselineYear, percentageChange, materials } = req.body || {};
    if (!targetYear) return res.status(400).json({ success: false, error: { message: 'targetYear is required.' } });
    if (!Array.isArray(materials) || materials.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'No predicted materials to save — run a preview first.' } });
    }

    const createdBy = req.session?.user?.username || 'unknown';
    const runId = await db.createMrpForecastRun({
      targetYear: Number(targetYear), method: 'Percentage',
      baselineYear: baselineYear ? Number(baselineYear) : null,
      percentageChange: percentageChange !== undefined ? Number(percentageChange) : null,
      createdBy, materials,
    });

    await auditQuery('MRP_FORECAST_SAVE', createdBy,
      `Saved a Percentage MRP forecast for ${targetYear} (${materials.length} materials, run #${runId})`, req);

    res.json({ success: true, data: { runId } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Forecast — Sales breakdown method ───────────────────────────────────────
// Download: every material in TurnsValClassSnapshot (i.e. every product Nexus tracks at
// this plant — see listMaterialsForSalesExport's own comment for why that's the right list),
// plus a blank "Expected Sales Units" column for the operator to fill in offline. Re-upload:
// matched by header text (not column position — same resilience reasoning as the Month End
// Breakdown upload in routes/performance.js), exploded through SapServer's BOM-explosion
// endpoint, and returned as a PREVIEW (not saved — see this file's header comment).

const HEADER_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
const HEADER_FONT  = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
const HEADER_ALIGN = { vertical: 'middle', horizontal: 'left' };
const BODY_FONT     = { name: 'Arial', size: 10, color: { argb: 'FF000000' } };
const EVEN_FILL     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
const ODD_FILL      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEF4' } };
const BORDER_STYLE  = { style: 'thin', color: { argb: 'FFBFCAD4' } };
const CELL_BORDER   = { top: BORDER_STYLE, bottom: BORDER_STYLE, left: BORDER_STYLE, right: BORDER_STYLE };

// Column labels here are the exact header text the upload side matches on (readCellText
// below) — keep the two in sync if either changes.
const EXPORT_COLUMNS = ['Material', 'Material Text', 'Material Type', 'Profit Centre', 'Uom', 'Expected Sales Units'];

function writeMaterialsSheet(ws, rows) {
  const headerRow = ws.addRow(EXPORT_COLUMNS);
  headerRow.height = 22;
  headerRow.eachCell(cell => {
    cell.fill = HEADER_FILL; cell.font = HEADER_FONT; cell.alignment = HEADER_ALIGN; cell.border = CELL_BORDER;
  });

  rows.forEach((row, i) => {
    const dataRow = ws.addRow([row.Material, row.MaterialText, row.MaterialType, row.ProfitCentre, row.Uom, '']);
    const fill = i % 2 === 0 ? ODD_FILL : EVEN_FILL;
    dataRow.eachCell(cell => { cell.fill = fill; cell.font = BODY_FONT; cell.border = CELL_BORDER; });
  });

  ws.columns.forEach((col, idx) => {
    const header = EXPORT_COLUMNS[idx] || '';
    let maxLen = header.length;
    rows.forEach(row => {
      const v = [row.Material, row.MaterialText, row.MaterialType, row.ProfitCentre, row.Uom][idx];
      const l = v != null ? String(v).length : 0;
      if (l > maxLen) maxLen = l;
    });
    col.width = Math.min(maxLen + 3, 52);
  });

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: EXPORT_COLUMNS.length } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

router.get('/products/export', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const rows = await db.listMaterialsForSalesExport();

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Kongsberg Portal';
    wb.created = new Date();
    const ws = wb.addWorksheet('Data');
    writeMaterialsSheet(ws, rows);

    const filename = `mrp-sales-forecast-template_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[mrp-analysis/products/export]', err.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: { message: err.message } });
  }
});

function buildHeaderMap(headerRow) {
  const map = {};
  headerRow.eachCell((cell, colNumber) => {
    const text = String(cell.value || '').trim();
    if (text) map[text] = colNumber;
  });
  return map;
}

function readCellText(row, colNumber) {
  if (!colNumber) return '';
  const v = row.getCell(colNumber).value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ('result' in v) return String(v.result ?? '').trim();
    if ('text' in v) return String(v.text ?? '').trim();
    return '';
  }
  return String(v).trim();
}

router.post('/forecast/bom/upload',
  requirePermission('LOG_MRP'),
  express.raw({
    type: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/octet-stream',
    ],
    limit: '20mb',
  }),
  async (req, res) => {
    try {
      const targetYear = Number(req.query.targetYear);
      if (!targetYear) return res.status(400).json({ success: false, error: { message: 'targetYear query parameter is required.' } });

      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ success: false, error: { message: 'No file content received.' } });
      }

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.body);

      const ws = wb.getWorksheet('Data');
      if (!ws) {
        return res.status(400).json({ success: false, error: { message: 'This file has no "Data" sheet — is it a Sales Forecast Template export?' } });
      }

      const headerMap = buildHeaderMap(ws.getRow(1));
      const results = [];
      const products = [];

      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return; // header

        const material = readCellText(row, headerMap['Material']);
        const salesText = readCellText(row, headerMap['Expected Sales Units']);
        if (!material || !salesText) return; // blank row / raw-material row the operator left blank — not an error

        const expectedSalesUnits = Number(salesText);
        if (!Number.isFinite(expectedSalesUnits) || expectedSalesUnits <= 0) {
          results.push({ row: rowNumber, success: false, error: `Invalid "Expected Sales Units" value "${salesText}" for material ${material}.` });
          return;
        }

        products.push({ material, expectedSalesUnits });
        results.push({ row: rowNumber, success: true });
      });

      if (products.length === 0) {
        return res.status(400).json({ success: false, error: { message: 'No rows had an "Expected Sales Units" value entered.' } });
      }

      const sapResult = await sap.postExplodeBom(req, {
        Items: products.map(p => ({ Material: p.material, Quantity: p.expectedSalesUnits })),
      });

      const succeeded = results.filter(r => r.success).length;
      res.json({
        success: true,
        data: {
          targetYear,
          total: results.length, succeeded, failed: results.length - succeeded, results,
          products,
          rawMaterials: sapResult.rawMaterials || [],
          unresolved: sapResult.unresolved || [],
        },
      });
    } catch (err) {
      console.error('[mrp-analysis/forecast/bom/upload]', err.message);
      res.status(500).json({ success: false, error: { message: err.message } });
    }
  }
);

router.post('/forecast/bom/save', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { targetYear, products, rawMaterials } = req.body || {};
    if (!targetYear) return res.status(400).json({ success: false, error: { message: 'targetYear is required.' } });
    if (!Array.isArray(rawMaterials) || rawMaterials.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'No raw materials to save — run an upload/calculate first.' } });
    }

    const createdBy = req.session?.user?.username || 'unknown';
    const runId = await db.createMrpForecastRun({
      targetYear: Number(targetYear), method: 'BomBreakdown',
      createdBy,
      materials: rawMaterials.map(r => ({ material: r.material, predictedQty: r.quantity, uom: r.uom })),
      products: Array.isArray(products) ? products : [],
    });

    await auditQuery('MRP_FORECAST_SAVE', createdBy,
      `Saved a Sales Breakdown MRP forecast for ${targetYear} (${rawMaterials.length} raw materials, run #${runId})`, req);

    res.json({ success: true, data: { runId } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Snapshot history ─────────────────────────────────────────────────────────

router.get('/forecast/runs', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const targetYear = req.query.targetYear ? Number(req.query.targetYear) : null;
    const data = await db.listMrpForecastRuns(targetYear);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/forecast/runs/:runId', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const data = await db.getMrpForecastRunDetail(Number(req.params.runId));
    if (!data) return res.status(404).json({ success: false, error: { message: 'Forecast run not found.' } });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export default router;
