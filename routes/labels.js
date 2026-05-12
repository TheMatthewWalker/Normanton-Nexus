import express   from 'express';
import sql       from 'mssql';
import PDFDocument from 'pdfkit';
import bwipjs    from 'bwip-js';
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

// ── Helpers ───────────────────────────────────────────────────────────────────
async function makeBarcode(text) {
  const clean = String(text ?? '').toUpperCase().replace(/[^A-Z0-9\-\.\$\/\+\% ]/g, '');
  if (!clean) return null;
  try {
    return await bwipjs.toBuffer({
      bcid:          'code39',
      text:          clean,
      scale:         2,
      height:        10,
      includetext:   false,
      paddingwidth:  4,
      paddingheight: 2,
    });
  } catch { return null; }
}

function fmtLabel(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function displayName(row) {
  const full = [row.FirstName, row.LastName].filter(Boolean).join(' ').trim();
  return full || row.Username || '—';
}

// ── DB fetch ──────────────────────────────────────────────────────────────────
async function fetchLabelData(processCode, recordID) {
  const cfg  = PROC[processCode];
  const pool = await getProductionPool();

  // ── Main record ──────────────────────────────────────────────────────────
  let rec;
  if (processCode === 'MX') {
    const r = await pool.request()
      .input('id', sql.Int, recordID)
      .query(`SELECT m.MixingID AS RecordID, m.MixRef AS BatchRef,
                     m.Material, m.TotalWeightKG AS Quantity,
                     m.Status, m.CreatedAt, m.CompletedAt, m.Notes,
                     m.SupplierBatchNo, m.SupplierTubNo,
                     s.ShiftName,
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

  // ── Operators ────────────────────────────────────────────────────────────
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

  // ── Traceability ─────────────────────────────────────────────────────────
  const traceR = await pool.request()
    .input('pc',  sql.NVarChar(5), processCode)
    .input('rid', sql.Int,         recordID)
    .query(`SELECT ParentProcessCode, ParentRecordID
            FROM   prod.ProductionTrace
            WHERE  ChildProcessCode = @pc AND ChildRecordID = @rid
            ORDER  BY LinkedAt`);

  // ── SAP material document (completed non-BR) ─────────────────────────────
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
    processName: PROC[processCode].name,
    batchRef,
    status:      rec.Status,
    material:    rec.Material || '—',
    machine:     rec.MachineName || rec.MachineCode || null,
    shiftName:   rec.ShiftName  || null,
    operators:   opsR.recordset,
    createdAt:   rec.CreatedAt,
    completedAt: rec.CompletedAt,
    quantity:    rec.Quantity,
    uom:         PROC[processCode].uom,
    parentBatches: traceR.recordset.map(r =>
      `${r.ParentProcessCode}${String(r.ParentRecordID).padStart(8, '0')}`),
    sapMatDoc,
    notes:           rec.Notes         || null,
    supplierBatchNo: rec.SupplierBatchNo || null,
    supplierTubNo:   rec.SupplierTubNo   || null,
  };
}

// ── PDF builder ───────────────────────────────────────────────────────────────
const C = {
  teal:    '#0d4c45',
  tealMid: '#0d9488',
  amber:   '#d97706',
  red:     '#dc2626',
  text:    '#111827',
  muted:   '#6b7280',
  border:  '#d1d5db',
  white:   '#ffffff',
};

const STATUS_BADGE = {
  1: { text: 'OPEN',             fill: '#d97706' },
  2: { text: 'RUNNING',          fill: '#0d9488' },
  3: { text: 'ON HOLD',          fill: '#6b7280' },
  4: { text: 'COMPLETE',         fill: '#0d9488' },
  5: { text: 'CANCELLED',        fill: '#dc2626' },
  6: { text: 'BACKFLUSH FAILED', fill: '#dc2626' },
};

// Read pixel dimensions from a PNG buffer header (bytes 16–23).
function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// Rendered height of a PNG image when displayed at a given width (aspect-ratio preserved).
function renderedH(buf, displayW) {
  const { w, h } = pngSize(buf);
  return (h / w) * displayW;
}

async function buildPDF(data) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size:   'A5',
        layout: 'landscape',
        margin: 0,
        info:   { Title: `${data.processName} Label — ${data.batchRef}`, Author: 'Kongsberg Automotive' },
      });

      const chunks = [];
      doc.on('data',  c  => chunks.push(c));
      doc.on('end',   () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W  = doc.page.width;   // ≈595
      const H  = doc.page.height;  // ≈420
      const ML = 18;
      const CW = W - 2 * ML;      // ≈559
      const isComplete = data.status === 4;

      // ── Header bar ──────────────────────────────────────────────────────
      const HDR = 46;
      doc.rect(0, 0, W, HDR).fill(C.teal);

      doc.font('Helvetica-Bold').fontSize(13).fillColor(C.white)
         .text('KONGSBERG AUTOMOTIVE', ML, 10, { lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor('rgba(255,255,255,0.7)')
         .text(data.processName.toUpperCase() + ' — PRODUCTION ENTRY', ML, 27, { lineBreak: false });

      // Status badge — width adapts to text length
      const badgeInfo  = STATUS_BADGE[data.status] || { text: `STATUS ${data.status}`, fill: C.muted };
      const badgeText  = badgeInfo.text;
      doc.font('Helvetica-Bold').fontSize(8);
      const badgeTextW = doc.widthOfString(badgeText);
      const badgeW     = badgeTextW + 20;
      const badgeH     = 22;
      const badgeX     = W - ML - badgeW;
      const badgeY     = 12;
      doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 4).fill(badgeInfo.fill);
      doc.fillColor(C.white)
         .text(badgeText, badgeX, badgeY + 6, { width: badgeW, align: 'center', lineBreak: false });

      let y = HDR + 10;

      // ── Batch reference ──────────────────────────────────────────────────
      doc.font('Helvetica-Bold').fontSize(7).fillColor(C.muted)
         .text('BATCH REFERENCE', ML, y, { lineBreak: false });
      y += 12;

      const bcRef = await makeBarcode(data.batchRef);
      if (bcRef) {
        const bw = Math.min(CW * 0.65, 320);
        const bh = renderedH(bcRef, bw);
        doc.image(bcRef, ML + (CW - bw) / 2, y, { width: bw });
        y += bh + 5;
      }

      doc.font('Helvetica-Bold').fontSize(14).fillColor(C.text)
         .text(data.batchRef, ML, y, { width: CW, align: 'center', lineBreak: false });
      y += 20;

      // ── Divider ──────────────────────────────────────────────────────────
      doc.moveTo(ML, y).lineTo(W - ML, y).strokeColor(C.border).lineWidth(0.5).stroke();
      y += 8;

      // ── Two-column info grid ─────────────────────────────────────────────
      const HALF = CW / 2;
      const xR   = ML + HALF + 8;

      // Material | Machine
      doc.font('Helvetica-Bold').fontSize(7).fillColor(C.muted)
         .text('MATERIAL', ML, y, { lineBreak: false })
         .text('MACHINE', xR, y, { lineBreak: false });
      y += 11;

      doc.font('Helvetica-Bold').fontSize(10).fillColor(C.text)
         .text(data.material, ML, y, { width: HALF - 12, lineBreak: false })
         .text(data.machine || '—', xR, y, { width: HALF - 8, lineBreak: false });
      y += 14;

      const bcMat = await makeBarcode(data.material);
      if (bcMat) {
        const matW = Math.min(HALF - 20, 190);
        const matH = renderedH(bcMat, matW);
        doc.image(bcMat, ML, y, { width: matW });
        y += matH + 4;
      }

      // Operator(s) | Date
      const primaryOp = data.operators.find(o => o.IsPrimary) || data.operators[0];
      const opList    = isComplete
        ? data.operators.map(o => o.DisplayName || o.Username).join(', ')
        : (primaryOp?.DisplayName || primaryOp?.Username || '—');
      const dateLabel = isComplete ? 'COMPLETED' : 'CREATED';
      const dateVal   = fmtLabel(isComplete ? data.completedAt : data.createdAt);

      doc.font('Helvetica-Bold').fontSize(7).fillColor(C.muted)
         .text(isComplete ? 'OPERATORS' : 'OPERATOR', ML, y, { lineBreak: false })
         .text(dateLabel, xR, y, { lineBreak: false });
      y += 11;

      doc.font('Helvetica').fontSize(9).fillColor(C.text)
         .text(opList, ML, y, { width: HALF - 12, lineBreak: false })
         .text(dateVal, xR, y, { width: HALF - 8, lineBreak: false });
      y += 16;

      // ── Divider ──────────────────────────────────────────────────────────
      doc.moveTo(ML, y).lineTo(W - ML, y).strokeColor(C.border).lineWidth(0.5).stroke();
      y += 8;

      // ── Traceability ─────────────────────────────────────────────────────
      doc.font('Helvetica-Bold').fontSize(7).fillColor(C.muted)
         .text('INPUT BATCHES', ML, y, { lineBreak: false });
      y += 11;

      if (data.processCode === 'MX') {
        const parts = [];
        if (data.supplierBatchNo) parts.push(`Supplier Batch: ${data.supplierBatchNo}`);
        if (data.supplierTubNo)   parts.push(`Tub No: ${data.supplierTubNo}`);
        doc.font('Helvetica').fontSize(9).fillColor(C.text)
           .text(parts.length ? parts.join('    ') : '—', ML, y, { width: CW, lineBreak: false });
      } else {
        doc.font('Helvetica').fontSize(9).fillColor(C.text)
           .text(data.parentBatches.length ? data.parentBatches.join('    ') : '—', ML, y, { width: CW, lineBreak: false });
      }
      y += 14;

      // ── Completed-label additions ─────────────────────────────────────────
      if (isComplete) {
        doc.moveTo(ML, y).lineTo(W - ML, y).strokeColor(C.border).lineWidth(0.5).stroke();
        y += 8;

        const qLabel  = data.uom === 'KG' ? 'WEIGHT (KG)' : 'LENGTH (M)';
        const qValue  = data.quantity != null ? `${Number(data.quantity).toFixed(3)} ${data.uom}` : '—';
        const hasDoc  = Boolean(data.sapMatDoc);
        const QW      = hasDoc ? HALF - 12 : CW;

        doc.font('Helvetica-Bold').fontSize(7).fillColor(C.muted)
           .text(qLabel, ML, y, { lineBreak: false });
        if (hasDoc) {
          doc.font('Helvetica-Bold').fontSize(7).fillColor(C.muted)
             .text('SAP MATERIAL DOCUMENT', xR, y, { lineBreak: false });
        }
        y += 11;

        doc.font('Helvetica-Bold').fontSize(13).fillColor(C.teal)
           .text(qValue, ML, y, { width: QW, lineBreak: false });

        if (hasDoc) {
          const bcSap = await makeBarcode(data.sapMatDoc);
          if (bcSap) {
            const sapW = Math.min(HALF - 20, 180);
            const sapH = renderedH(bcSap, sapW);
            doc.image(bcSap, xR, y, { width: sapW });
            y += sapH + 4;
          } else {
            y += 16;
          }
          doc.font('Helvetica-Bold').fontSize(10).fillColor(C.text)
             .text(data.sapMatDoc, xR, y, { lineBreak: false });
          y += 16;
        } else {
          y += 20;
        }

        // Notes
        if (data.notes) {
          doc.moveTo(ML, y).lineTo(W - ML, y).strokeColor(C.border).lineWidth(0.5).stroke();
          y += 8;
          doc.font('Helvetica-Bold').fontSize(7).fillColor(C.muted)
             .text('NOTES', ML, y, { lineBreak: false });
          y += 11;
          doc.font('Helvetica').fontSize(9).fillColor(C.text)
             .text(data.notes, ML, y, { width: CW });
        }
      }

      // ── Footer rule ───────────────────────────────────────────────────────
      doc.moveTo(0, H - 18).lineTo(W, H - 18).strokeColor(C.teal).lineWidth(2).stroke();
      doc.font('Helvetica').fontSize(7).fillColor(C.muted)
         .text(`Printed ${fmtLabel(new Date())}  ·  ${data.batchRef}`, ML, H - 14,
               { width: CW, align: 'left', lineBreak: false });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
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
    const pdf  = await buildPDF(data);

    const filename = `${data.batchRef}-label.pdf`;
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Length':      pdf.length,
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control':       'no-store',
    });
    res.send(pdf);
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message });
  }
});

export default router;
