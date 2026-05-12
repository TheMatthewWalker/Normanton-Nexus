import net         from 'node:net';
import express     from 'express';
import sql         from 'mssql';
import PDFDocument from 'pdfkit';
import bwipjs      from 'bwip-js';
import { getProductionPool, printersConfig, sqlConfig } from '../server.js';

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

// ── Shared helpers ────────────────────────────────────────────────────────────
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

// Barcode PNG buffer (used by both PDF and HTML paths)
async function barcodeBuffer(text) {
  const clean = String(text ?? '').toUpperCase().replace(/[^A-Z0-9\-\.\$\/\+\% ]/g, '');
  if (!clean) return null;
  try {
    return await bwipjs.toBuffer({
      bcid: 'code39', text: clean,
      scale: 3, height: 10,
      includetext: false, paddingwidth: 4, paddingheight: 2,
    });
  } catch { return null; }
}

// Read PNG pixel dimensions from buffer header (bytes 16-23)
function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// Rendered height when displayed at a given width (aspect-ratio preserved)
function renderedH(buf, displayW) {
  const { w, h } = pngSize(buf);
  return (h / w) * displayW;
}

// ── DB fetch (shared by both HTML preview and PDF print) ──────────────────────
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

// ── PDF builder (used for server-side printing) ───────────────────────────────
async function buildPDF(data) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A5', layout: 'landscape', margin: 0,
        info: { Title: `${data.processName} Label — ${data.batchRef}`, Author: 'Kongsberg Automotive' },
      });
      const chunks = [];
      doc.on('data',  c  => chunks.push(c));
      doc.on('end',   () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W  = doc.page.width;   // ≈595
      const H  = doc.page.height;  // ≈420
      const M  = 12;
      const CW = W - 2 * M;
      const isComplete = data.status === 4;
      const badge = STATUS_BADGE[data.status] || { text: `STATUS ${data.status}`, bg: '#6b7280' };

      // ── Header ──────────────────────────────────────────────────────────────
      const HDR = 38;
      doc.rect(0, 0, W, HDR).fill('#0d4c45');
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#ffffff')
         .text('KONGSBERG AUTOMOTIVE', M, 8, { lineBreak: false });
      doc.font('Helvetica').fontSize(8).fillColor('rgba(255,255,255,0.7)')
         .text(`${data.processName.toUpperCase()} — PRODUCTION ENTRY`, M, 24, { lineBreak: false });

      doc.font('Helvetica-Bold').fontSize(7);
      const bdgTW = doc.widthOfString(badge.text);
      const bdgW  = bdgTW + 16, bdgH = 18, bdgX = W - M - bdgTW - 16, bdgY = 10;
      doc.roundedRect(bdgX, bdgY, bdgW, bdgH, 3).fill(badge.bg);
      doc.fillColor('#ffffff').text(badge.text, bdgX, bdgY + 5,
        { width: bdgW, align: 'center', lineBreak: false });

      let y = HDR + 8;
      const HALF = CW / 2;
      const xR   = M + HALF + 8;

      // ── Top row: Batch ref  |  SAP doc ──────────────────────────────────────
      const bcRef = await barcodeBuffer(data.batchRef);
      const bcSap = (isComplete && data.sapMatDoc) ? await barcodeBuffer(data.sapMatDoc) : null;
      const BW    = Math.min(HALF - 10, 250);

      doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280')
         .text('BATCH REFERENCE', M, y, { lineBreak: false });
      if (bcSap) {
        doc.text('SAP MATERIAL DOCUMENT', xR, y, { lineBreak: false });
      }
      y += 9;

      let bcRowH = 0;
      if (bcRef) {
        const bh = renderedH(bcRef, BW);
        doc.image(bcRef, M, y, { width: BW });
        bcRowH = Math.max(bcRowH, bh);
      }
      if (bcSap) {
        const bh = renderedH(bcSap, BW);
        doc.image(bcSap, xR, y, { width: BW });
        bcRowH = Math.max(bcRowH, bh);
      }
      y += bcRowH + 3;

      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827')
         .text(data.batchRef, M, y, { width: HALF - 10, lineBreak: false });
      if (bcSap) {
        doc.text(data.sapMatDoc, xR, y, { width: HALF - 10, lineBreak: false });
      }
      y += 16;

      // Divider
      doc.moveTo(M, y).lineTo(W - M, y).strokeColor('#d1d5db').lineWidth(0.5).stroke();
      y += 6;

      // ── Material  |  Machine ─────────────────────────────────────────────────
      const bcMat = await barcodeBuffer(data.material);
      doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280')
         .text('MATERIAL', M, y, { lineBreak: false })
         .text('MACHINE',  xR, y, { lineBreak: false });
      y += 9;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#111827')
         .text(data.material,          M,  y, { width: HALF - 10, lineBreak: false })
         .text(data.machine || '—',    xR, y, { width: HALF - 8,  lineBreak: false });
      y += 12;
      if (bcMat) {
        const mw = Math.min(HALF - 20, 160);
        const mh = renderedH(bcMat, mw);
        doc.image(bcMat, M, y, { width: mw });
        y += mh + 3;
      }

      // ── Operators  |  Date ───────────────────────────────────────────────────
      const primaryOp = data.operators.find(o => o.IsPrimary) || data.operators[0];
      const opList    = isComplete
        ? data.operators.map(o => o.DisplayName || o.Username).join(', ')
        : (primaryOp?.DisplayName || primaryOp?.Username || '—');
      const dateLabel = isComplete ? 'COMPLETED' : 'CREATED';
      const dateVal   = fmtLabel(isComplete ? data.completedAt : data.createdAt);

      doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280')
         .text(isComplete ? 'OPERATORS' : 'OPERATOR', M, y, { lineBreak: false })
         .text(dateLabel, xR, y, { lineBreak: false });
      y += 9;
      doc.font('Helvetica').fontSize(8).fillColor('#111827')
         .text(opList,   M,  y, { width: HALF - 10, lineBreak: false })
         .text(dateVal,  xR, y, { width: HALF - 8,  lineBreak: false });
      y += 13;

      // Divider
      doc.moveTo(M, y).lineTo(W - M, y).strokeColor('#d1d5db').lineWidth(0.5).stroke();
      y += 6;

      // ── Traceability ─────────────────────────────────────────────────────────
      doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280')
         .text('INPUT BATCHES', M, y, { lineBreak: false });
      y += 9;

      let traceStr;
      if (data.processCode === 'MX') {
        const parts = [];
        if (data.supplierBatchNo) parts.push(`Supplier Batch: ${data.supplierBatchNo}`);
        if (data.supplierTubNo)   parts.push(`Tub No: ${data.supplierTubNo}`);
        traceStr = parts.join('   ') || '—';
      } else {
        traceStr = data.parentBatches.join('   ') || '—';
      }
      doc.font('Helvetica').fontSize(8).fillColor('#111827')
         .text(traceStr, M, y, { width: CW, lineBreak: false });
      y += 13;

      // ── Completion section ───────────────────────────────────────────────────
      if (isComplete) {
        doc.moveTo(M, y).lineTo(W - M, y).strokeColor('#d1d5db').lineWidth(0.5).stroke();
        y += 6;

        const qLabel = data.uom === 'KG' ? 'WEIGHT (KG)' : 'LENGTH (M)';
        const qValue = data.quantity != null ? `${Number(data.quantity).toFixed(3)} ${data.uom}` : '—';
        doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280')
           .text(qLabel, M, y, { lineBreak: false });
        y += 9;
        doc.font('Helvetica-Bold').fontSize(12).fillColor('#0d4c45')
           .text(qValue, M, y, { lineBreak: false });
        y += 18;

        if (data.notes) {
          doc.moveTo(M, y).lineTo(W - M, y).strokeColor('#d1d5db').lineWidth(0.5).stroke();
          y += 6;
          doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280')
             .text('NOTES', M, y, { lineBreak: false });
          y += 9;
          doc.font('Helvetica').fontSize(8).fillColor('#111827')
             .text(data.notes, M, y, { width: CW });
        }
      }

      // ── Footer ───────────────────────────────────────────────────────────────
      doc.moveTo(0, H - 14).lineTo(W, H - 14).strokeColor('#0d4c45').lineWidth(2).stroke();
      doc.font('Helvetica').fontSize(6).fillColor('#9ca3af')
         .text(`Printed ${fmtLabel(new Date())}  ·  ${data.batchRef}`, M, H - 10,
               { width: CW, lineBreak: false });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ── HTML preview builder (used for browser preview tab) ───────────────────────
function bcImg(src, heightMm) {
  if (!src) return '';
  return `<img src="${src}" style="display:block;height:${heightMm}mm;width:auto;max-width:100%">`;
}

async function buildHTML(data) {
  const isComplete = data.status === 4;
  const badge      = STATUS_BADGE[data.status] || { text: `STATUS ${data.status}`, bg: '#6b7280' };

  const bcRef = await barcodeBuffer(data.batchRef);
  const bcMat = await barcodeBuffer(data.material);
  const bcSap = data.sapMatDoc ? await barcodeBuffer(data.sapMatDoc) : null;

  const b64 = buf => buf ? `data:image/png;base64,${buf.toString('base64')}` : null;

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
    : (data.parentBatches.length ? data.parentBatches.map(esc).join(' &nbsp;&nbsp; ') : '—');

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
    width: 210mm; height: 148mm; overflow: hidden;
    font-family: Helvetica Neue, Helvetica, Arial, sans-serif;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .label { width: 210mm; height: 148mm; display: flex; flex-direction: column; }
  .header {
    background: #0d4c45; color: #fff;
    padding: 6px 12px;
    display: flex; justify-content: space-between; align-items: center;
    flex-shrink: 0;
  }
  .co-name { font-size: 11pt; font-weight: 700; letter-spacing: 0.02em; }
  .co-proc { font-size: 7.5pt; opacity: 0.75; margin-top: 2px; }
  .badge   { font-size: 7pt; font-weight: 700; color: #fff; padding: 3px 9px; border-radius: 4px; white-space: nowrap; }
  .body    { flex: 1; overflow: hidden; padding: 6px 12px 2px; display: flex; flex-direction: column; gap: 4px; }
  .lbl     { font-size: 5.5pt; font-weight: 700; color: #6b7280; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 2px; }
  .divider { border: none; border-top: 0.5px solid #d1d5db; margin: 2px 0; flex-shrink: 0; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
  .batch-id { font-size: 11pt; font-weight: 700; letter-spacing: 0.08em; margin-top: 1px; }
  .mat-val  { font-size: 9pt;  font-weight: 700; }
  .mat-bc img { height: 9mm; width: auto; max-width: 100%; margin-top: 2px; }
  .mach-val { font-size: 9pt; font-weight: 700; }
  .op-val   { font-size: 8pt; }
  .date-val { font-size: 8pt; }
  .trace-val { font-size: 8pt; }
  .qty      { font-size: 12pt; font-weight: 700; color: #0d4c45; margin-top: 1px; }
  .notes    { font-size: 7.5pt; }
  .footer   { border-top: 2px solid #0d4c45; padding: 2px 12px; font-size: 6pt; color: #9ca3af; flex-shrink: 0; }
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
        ${bcImg(b64(bcRef), 13)}
        <div class="batch-id">${esc(data.batchRef)}</div>
      </div>
      ${isComplete && data.sapMatDoc ? `
      <div>
        <div class="lbl">SAP MATERIAL DOCUMENT</div>
        ${bcImg(b64(bcSap), 13)}
        <div class="batch-id">${esc(data.sapMatDoc)}</div>
      </div>` : ''}
    </div>
    <div class="divider"></div>
    <div class="two-col">
      <div>
        <div class="lbl">MATERIAL</div>
        <div class="mat-val">${esc(data.material)}</div>
        <div class="mat-bc">${bcImg(b64(bcMat), 9)}</div>
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

// ── TCP direct print (RAW port 9100) ──────────────────────────────────────────
function tcpPrint(buffer, host, port = 9100) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    sock.setTimeout(15000);
    sock.connect(Number(port), host, () => {
      sock.write(buffer, err => {
        if (err) { sock.destroy(); return reject(err); }
        sock.end();
      });
    });
    sock.on('close', () => resolve());
    sock.on('error', err => { sock.destroy(); reject(err); });
    sock.on('timeout', () => { sock.destroy(); reject(new Error(`Printer ${host}:${port} timed out after 15s`)); });
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// List configured printers + the requesting user's personal default
router.get('/printers', async (req, res) => {
  try {
    const uid = req.session?.user?.userID;
    let userDefault = null;
    if (uid) {
      const pool = await sql.connect(sqlConfig);
      const r = await pool.request()
        .input('uid', sql.Int, uid)
        .query(`SELECT DefaultPrinterID FROM kongsberg.dbo.PortalUsers WHERE UserID = @uid`);
      userDefault = r.recordset[0]?.DefaultPrinterID || null;
    }
    res.json({
      success:     true,
      data:        printersConfig.map(p => ({ id: p.id, name: p.name })),
      userDefault,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save (or clear) the user's personal default printer
router.patch('/printers/default', async (req, res) => {
  const uid = req.session?.user?.userID;
  if (!uid) return res.status(401).json({ error: 'Not logged in.' });
  const { printerId } = req.body;
  try {
    const pool = await sql.connect(sqlConfig);
    await pool.request()
      .input('uid', sql.Int,           uid)
      .input('pid', sql.NVarChar(50),  printerId || null)
      .query(`UPDATE kongsberg.dbo.PortalUsers SET DefaultPrinterID = @pid WHERE UserID = @uid`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Browser preview (opens in new tab, auto-prints via window.print())
router.get('/process/:processCode/:recordID', async (req, res) => {
  const code     = req.params.processCode.toUpperCase();
  const recordID = Number(req.params.recordID);
  if (!SUPPORTED.has(code)) return res.status(400).json({ error: `Label not supported for ${code}.` });
  if (!recordID)            return res.status(400).json({ error: 'Invalid record ID.' });
  try {
    const data = await fetchLabelData(code, recordID);
    const html = await buildHTML(data);
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.send(html);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Server-side print — generates PDF and sends directly to network printer
router.post('/process/:processCode/:recordID/print', async (req, res) => {
  const code     = req.params.processCode.toUpperCase();
  const recordID = Number(req.params.recordID);
  if (!SUPPORTED.has(code)) return res.status(400).json({ error: `Label not supported for ${code}.` });
  if (!recordID)            return res.status(400).json({ error: 'Invalid record ID.' });

  const { printerId } = req.body;
  const printer = printerId
    ? printersConfig.find(p => p.id === printerId)
    : printersConfig[0];

  if (!printer)
    return res.status(400).json({ error: printersConfig.length === 0
      ? 'No printers configured. Add a "printers" array to config.json.'
      : `Printer "${printerId}" not found.` });

  try {
    const data = await fetchLabelData(code, recordID);
    const pdf  = await buildPDF(data);
    await tcpPrint(pdf, printer.host, printer.port ?? 9100);
    res.json({ success: true, message: `Sent to ${printer.name || printer.host}` });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

export default router;
