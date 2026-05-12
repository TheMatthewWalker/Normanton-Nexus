import express from 'express';
import sql     from 'mssql';
import bwipjs  from 'bwip-js';
import { getProductionPool } from '../server.js';

const router = express.Router();

// ── Process config ────────────────────────────────────────────────────────────
const SUPPORTED = new Set(['MX', 'EX', 'CO', 'BR', 'CL', 'TW']);

const PROC = {
  MX: { table: 'prod.Mixing',      pk: 'MixingID',      uom: 'KG', qtyCol: 'TotalWeightKG', name: 'Mixing'      },
  EX: { table: 'prod.Extrusion',   pk: 'ExtrusionID',   uom: 'M',  qtyCol: 'LengthMetres',  name: 'Extrusion'   },
  CO: { table: 'prod.Convoluting', pk: 'ConvolutingID', uom: 'M',  qtyCol: 'LengthMetres',  name: 'Convoluting' },
  BR: { table: 'prod.Braiding',    pk: 'BraidingID',    uom: 'M',  qtyCol: 'LengthMetres',  name: 'Braiding'    },
  CL: { table: 'prod.Coverline',   pk: 'CoverlineID',   uom: 'M',  qtyCol: 'LengthMetres',  name: 'Coverline'   },
  TW: { table: 'prod.TapeWrap',    pk: 'TapeWrapID',    uom: 'M',  qtyCol: 'LengthMetres',  name: 'Tape Wrap'   },
};

const STATUS_BADGE = {
  1: { text: 'OPEN',             bg: '#d97706' },
  2: { text: 'RUNNING',          bg: '#0d9488' },
  3: { text: 'ON HOLD',          bg: '#6b7280' },
  4: { text: 'COMPLETE',         bg: '#0d9488' },
  5: { text: 'CANCELLED',        bg: '#dc2626' },
  6: { text: 'BACKFLUSH FAILED', bg: '#dc2626' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtLabel(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

async function barcode64(text) {
  const clean = String(text ?? '').toUpperCase().replace(/[^A-Z0-9\-\.\$\/\+\% ]/g, '');
  if (!clean) return null;
  try {
    const buf = await bwipjs.toBuffer({
      bcid: 'code39', text: clean,
      scale: 3, height: 10,
      includetext: false, paddingwidth: 4, paddingheight: 2,
    });
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch { return null; }
}

function bcImg(src, heightMm) {
  if (!src) return '';
  return `<img src="${src}" style="display:block;height:${heightMm}mm;width:auto;max-width:100%">`;
}

// ── DB fetch ──────────────────────────────────────────────────────────────────
async function fetchLabelData(processCode, recordID) {
  const cfg  = PROC[processCode];
  const pool = await getProductionPool();

  let rec;
  if (processCode === 'MX') {
    const r = await pool.request()
      .input('id', sql.Int, recordID)
      .query(`SELECT m.MixingID AS RecordID, m.MixRef AS BatchRef,
                     m.Material, m.TotalWeightKG AS Quantity,
                     m.Status, m.CreatedAt, m.CompletedAt, m.Notes,
                     m.SupplierBatchNo, m.SupplierTubNo, s.ShiftName,
                     pu.Username,
                     COALESCE(NULLIF(RTRIM(ISNULL(pu.FirstName,'')+' '+ISNULL(pu.LastName,'')), ''), pu.Username) AS DisplayName
              FROM   prod.Mixing m
              LEFT JOIN prod.Shifts              s  ON s.ShiftID  = m.ShiftID
              LEFT JOIN kongsberg.dbo.PortalUsers pu ON pu.UserID = m.CreatedByUserID
              WHERE  m.MixingID = @id`);
    rec = r.recordset[0];
  } else {
    const r = await pool.request()
      .input('id', sql.Int, recordID)
      .query(`SELECT t.${cfg.pk} AS RecordID, t.Material,
                     t.${cfg.qtyCol} AS Quantity,
                     t.Status, t.CreatedAt, t.CompletedAt, t.Notes,
                     s.ShiftName, mc.MachineName, mc.MachineCode,
                     pu.Username,
                     COALESCE(NULLIF(RTRIM(ISNULL(pu.FirstName,'')+' '+ISNULL(pu.LastName,'')), ''), pu.Username) AS DisplayName
              FROM   ${cfg.table} t
              LEFT JOIN prod.Shifts              s  ON s.ShiftID   = t.ShiftID
              LEFT JOIN prod.Machines            mc ON mc.MachineID = t.MachineID
              LEFT JOIN kongsberg.dbo.PortalUsers pu ON pu.UserID  = t.CreatedByUserID
              WHERE  t.${cfg.pk} = @id`);
    rec = r.recordset[0];
  }
  if (!rec) throw Object.assign(new Error('Record not found.'), { statusCode: 404 });

  const opsR = await pool.request()
    .input('pc',  sql.NVarChar(5), processCode)
    .input('rid', sql.Int,         recordID)
    .query(`SELECT bo.IsPrimary, pu.Username,
                   COALESCE(NULLIF(RTRIM(ISNULL(pu.FirstName,'')+' '+ISNULL(pu.LastName,'')), ''), pu.Username) AS DisplayName
            FROM   prod.BatchOperators bo
            JOIN   kongsberg.dbo.PortalUsers pu ON pu.UserID = bo.UserID
            WHERE  bo.ProcessCode = @pc AND bo.ProcessRecordID = @rid
              AND  bo.RemovedAt IS NULL
            ORDER  BY bo.IsPrimary DESC, bo.AssignedAt`);

  const traceR = await pool.request()
    .input('pc',  sql.NVarChar(5), processCode)
    .input('rid', sql.Int,         recordID)
    .query(`SELECT ParentProcessCode, ParentRecordID
            FROM   prod.ProductionTrace
            WHERE  ChildProcessCode = @pc AND ChildRecordID = @rid
            ORDER  BY LinkedAt`);

  let sapMatDoc = null;
  if (rec.Status === 4 && processCode !== 'BR') {
    const sapR = await pool.request()
      .input('pc',  sql.NVarChar(5), processCode)
      .input('rid', sql.Int,         recordID)
      .query(`SELECT TOP 1 MaterialDocumentSAP
              FROM   prod.SAPPostings
              WHERE  ProcessCode = @pc AND ProcessRecordID = @rid
                AND  PostingType = 'BACKFLUSH' AND IsSuccess = 1 AND IsReversed = 0
              ORDER  BY PostedAt`);
    sapMatDoc = sapR.recordset[0]?.MaterialDocumentSAP || null;
  }

  const batchRef = processCode === 'MX'
    ? (rec.BatchRef || `MX${String(recordID).padStart(8, '0')}`)
    : `${processCode}${String(recordID).padStart(8, '0')}`;

  return {
    processCode,
    processName:     PROC[processCode].name,
    batchRef,
    status:          rec.Status,
    material:        rec.Material || '—',
    machine:         rec.MachineName || rec.MachineCode || null,
    shiftName:       rec.ShiftName  || null,
    operators:       opsR.recordset,
    createdAt:       rec.CreatedAt,
    completedAt:     rec.CompletedAt,
    quantity:        rec.Quantity,
    uom:             PROC[processCode].uom,
    parentBatches:   traceR.recordset.map(r => `${r.ParentProcessCode}${String(r.ParentRecordID).padStart(8, '0')}`),
    sapMatDoc,
    notes:           rec.Notes          || null,
    supplierBatchNo: rec.SupplierBatchNo || null,
    supplierTubNo:   rec.SupplierTubNo   || null,
  };
}

// ── HTML label builder ────────────────────────────────────────────────────────
async function buildHTML(data) {
  const isComplete = data.status === 4;
  const badge      = STATUS_BADGE[data.status] || { text: `STATUS ${data.status}`, bg: '#6b7280' };

  const bcRef = await barcode64(data.batchRef);
  const bcMat = await barcode64(data.material);
  const bcSap = data.sapMatDoc ? await barcode64(data.sapMatDoc) : null;

  const primaryOp = data.operators.find(o => o.IsPrimary) || data.operators[0];
  const opList    = isComplete
    ? data.operators.map(o => esc(o.DisplayName || o.Username)).join(', ')
    : esc(primaryOp?.DisplayName || primaryOp?.Username || '—');
  const dateLabel = isComplete ? 'COMPLETED' : 'CREATED';
  const dateVal   = fmtLabel(isComplete ? data.completedAt : data.createdAt);

  const traceText = data.processCode === 'MX'
    ? [
        data.supplierBatchNo ? `Supplier Batch: ${esc(data.supplierBatchNo)}` : null,
        data.supplierTubNo   ? `Tub No: ${esc(data.supplierTubNo)}`           : null,
      ].filter(Boolean).join(' &nbsp;&nbsp; ') || '—'
    : (data.parentBatches.length
        ? data.parentBatches.map(esc).join(' &nbsp;&nbsp; ')
        : '—');

  const qLabel = data.uom === 'KG' ? 'WEIGHT (KG)' : 'LENGTH (M)';
  const qValue = data.quantity != null ? `${Number(data.quantity).toFixed(3)} ${esc(data.uom)}` : '—';

  const completionSection = isComplete ? `
    <div class="divider"></div>
    <div>
      <div class="lbl">${qLabel}</div>
      <div class="qty">${qValue}</div>
    </div>
    ${data.notes ? `
    <div class="divider"></div>
    <div class="lbl">NOTES</div>
    <div class="notes">${esc(data.notes)}</div>` : ''}
  ` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(data.batchRef)} — ${esc(data.processName)} Label</title>
<style>
  @page { size: 210mm 148mm; margin: 0; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 210mm; height: 148mm;
    overflow: hidden;
    font-family: Helvetica Neue, Helvetica, Arial, sans-serif;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .label {
    width: 210mm; height: 148mm;
    display: flex; flex-direction: column;
  }

  /* ── Header ── */
  .header {
    background: #0d4c45;
    color: #fff;
    padding: 6px 12px 6px 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }
  .co-name  { font-size: 11pt; font-weight: 700; letter-spacing: 0.02em; }
  .co-proc  { font-size: 7.5pt; opacity: 0.75; margin-top: 2px; }
  .badge {
    font-size: 7pt; font-weight: 700;
    color: #fff; padding: 3px 9px;
    border-radius: 4px; white-space: nowrap;
  }

  /* ── Content ── */
  .body {
    flex: 1; overflow: hidden;
    padding: 6px 12px 2px;
    display: flex; flex-direction: column; gap: 4px;
  }

  .lbl {
    font-size: 5.5pt; font-weight: 700;
    color: #6b7280; letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: 2px;
  }

  .divider {
    border: none;
    border-top: 0.5px solid #d1d5db;
    margin: 2px 0;
    flex-shrink: 0;
  }

  /* Batch reference / SAP doc */
  .batch-id {
    font-size: 11pt; font-weight: 700;
    letter-spacing: 0.08em; margin-top: 1px;
  }

  /* Two-column grid */
  .two-col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0 12px;
  }

  .mat-val  { font-size: 9pt;  font-weight: 700; }
  .mat-bc img { height: 9mm; width: auto; max-width: 100%; margin-top: 2px; }
  .mach-val { font-size: 9pt;  font-weight: 700; }

  .op-val   { font-size: 8pt; }
  .date-val { font-size: 8pt; }

  .trace-val { font-size: 8pt; }

  .qty      { font-size: 12pt; font-weight: 700; color: #0d4c45; margin-top: 1px; }
  .sap-num  { font-size: 9pt;  font-weight: 700; margin-top: 1px; }
  .notes    { font-size: 7.5pt; }

  /* ── Footer ── */
  .footer {
    border-top: 2px solid #0d4c45;
    padding: 2px 12px;
    font-size: 6pt; color: #9ca3af;
    flex-shrink: 0;
  }

  /* Screen-only: centre for preview */
  @media screen {
    html, body { display: flex; justify-content: center; align-items: flex-start; background: #e5e7eb; }
    .label { margin: 10px; box-shadow: 0 4px 20px rgba(0,0,0,0.2); }
  }
</style>
</head>
<body>
<div class="label">

  <div class="header">
    <div>
      <div class="co-name">KONGSBERG AUTOMOTIVE</div>
      <div class="co-proc">${esc(data.processName.toUpperCase())} — PRODUCTION ENTRY</div>
    </div>
    <div class="badge" style="background:${badge.bg}">${esc(badge.text)}</div>
  </div>

  <div class="body">

    <div class="two-col">
      <div>
        <div class="lbl">BATCH REFERENCE</div>
        ${bcImg(bcRef, 13)}
        <div class="batch-id">${esc(data.batchRef)}</div>
      </div>
      ${isComplete && data.sapMatDoc ? `
      <div>
        <div class="lbl">SAP MATERIAL DOCUMENT</div>
        ${bcImg(bcSap, 13)}
        <div class="batch-id">${esc(data.sapMatDoc)}</div>
      </div>` : ''}
    </div>

    <div class="divider"></div>

    <div class="two-col">
      <div>
        <div class="lbl">MATERIAL</div>
        <div class="mat-val">${esc(data.material)}</div>
        <div class="mat-bc">${bcImg(bcMat, 9)}</div>
      </div>
      <div>
        <div class="lbl">MACHINE</div>
        <div class="mach-val">${esc(data.machine || '—')}</div>
      </div>
    </div>

    <div class="two-col">
      <div>
        <div class="lbl">${isComplete ? 'OPERATORS' : 'OPERATOR'}</div>
        <div class="op-val">${opList}</div>
      </div>
      <div>
        <div class="lbl">${dateLabel}</div>
        <div class="date-val">${esc(dateVal)}</div>
      </div>
    </div>

    <div class="divider"></div>

    <div>
      <div class="lbl">INPUT BATCHES</div>
      <div class="trace-val">${traceText}</div>
    </div>

    ${completionSection}

  </div>

  <div class="footer">Printed ${esc(fmtLabel(new Date()))} &nbsp;·&nbsp; ${esc(data.batchRef)}</div>
</div>
<script>window.addEventListener('load', () => setTimeout(() => window.print(), 300));</script>
</body>
</html>`;
}

// ── Route ─────────────────────────────────────────────────────────────────────
router.get('/process/:processCode/:recordID', async (req, res) => {
  const code     = req.params.processCode.toUpperCase();
  const recordID = Number(req.params.recordID);

  if (!SUPPORTED.has(code))
    return res.status(400).json({ error: `Label generation not supported for process ${code}.` });
  if (!recordID)
    return res.status(400).json({ error: 'Invalid record ID.' });

  try {
    const data = await fetchLabelData(code, recordID);
    const html = await buildHTML(data);

    res.set({
      'Content-Type':  'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.send(html);
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message });
  }
});

export default router;
