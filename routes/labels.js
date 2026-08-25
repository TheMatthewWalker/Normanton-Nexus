import net         from 'node:net';
import express     from 'express';
import sql         from 'mssql';
import PDFDocument from 'pdfkit';
import bwipjs      from 'bwip-js';
import { getNexusOperationsPool, getNexusPool, printersConfig } from '../config.js';

const router = express.Router();

// ── Process config ────────────────────────────────────────────────────────────
const SUPPORTED = new Set(['MX', 'EX', 'CO', 'BR', 'CL', 'TW', 'DR']);

const PROC = {
  MX: { table: 'prod.Mixing',      pk: 'MixingID',      uom: 'KG', qtyCol: 'TotalWeightKG', name: 'Mixing'      },
  EX: { table: 'prod.Extrusion',   pk: 'ExtrusionID',   uom: 'M',  qtyCol: 'LengthMetres',  name: 'Extrusion'   },
  CO: { table: 'prod.Convoluting', pk: 'ConvolutingID', uom: 'M',  qtyCol: 'LengthMetres',  name: 'Convoluting' },
  BR: { table: 'prod.Braiding',    pk: 'BraidingID',    uom: 'M',  qtyCol: 'LengthMetres',  name: 'Braiding'    },
  CL: { table: 'prod.Coverline',   pk: 'CoverlineID',   uom: 'M',  qtyCol: 'LengthMetres',  name: 'Coverline'   },
  TW: { table: 'prod.TapeWrap',    pk: 'TapeWrapID',    uom: 'M',  qtyCol: 'LengthMetres',  name: 'Tape Wrap'   },
  DR: { table: 'prod.Drumming',    pk: 'DrummingID',    uom: 'M',  qtyCol: 'LengthMetres',  name: 'Drumming'    },
};

const STATUS_BADGE = {
  1: { text: 'OPEN',             bg: '#d97706' },
  2: { text: 'RUNNING',          bg: '#0d9488' },
  3: { text: 'ON HOLD',          bg: '#6b7280' },
  4: { text: 'COMPLETE',         bg: '#0d9488' },
  5: { text: 'CANCELLED',        bg: '#dc2626' },
  6: { text: 'BACKFLUSH FAILED', bg: '#dc2626' },
};

// Warehouse (pallet builder) labels use the same visual language as the
// production label below — header bar, one big value immediately followed
// by its barcode, footer rule — but a royal blue rather than the
// production label's teal, so the two are never confused at a glance from
// across the floor (the whole point of printing a "batch scanned"/"pallet
// finished" label is a fast visual check, not reading small text).
const WH_COLOR = '#1d4ed8';

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
  const pool = await getNexusOperationsPool();

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
              LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = m.CreatedByUserID
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
              LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID  = t.CreatedByUserID
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
            JOIN   Nexus.dbo.PortalUsers pu ON pu.UserID = bo.UserID
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

// ── Mixing — one ticket per tub ────────────────────────────────────────────
// A Mixing entry backflushes each tub to SAP separately (see
// prod.MixingTubs — TubWeightKG/MaterialDocumentSAP/SAPSuccess are all
// per-tub), but fetchLabelData's MX branch above pulls the record's
// combined TotalWeightKG and a "TOP 1 ... ORDER BY PostedAt" SAPPostings
// row — so a 3-tub batch printed one ticket showing the whole batch's
// weight and only the first tub's SAP material document number, silently
// dropping the other tubs' documents entirely. This builds one ticket data
// object per tub instead, each carrying that tub's own weight, SAP
// document, and supplier tub number.

async function fetchMixingHeader(recordID) {
  const pool = await getNexusOperationsPool();
  const r = await pool.request()
    .input('id', sql.Int, recordID)
    .query(`SELECT m.MixingID AS RecordID, m.MixRef AS BatchRef,
                   m.Material, m.Status, m.CreatedAt, m.CompletedAt, m.Notes,
                   m.SupplierBatchNo, s.ShiftName,
                   pu.Username,
                   COALESCE(NULLIF(RTRIM(ISNULL(pu.FirstName,'')+' '+ISNULL(pu.LastName,'')), ''), pu.Username) AS DisplayName
            FROM   prod.Mixing m
            LEFT JOIN prod.Shifts              s  ON s.ShiftID  = m.ShiftID
            LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = m.CreatedByUserID
            WHERE  m.MixingID = @id`);
  const rec = r.recordset[0];
  if (!rec) throw Object.assign(new Error('Record not found.'), { statusCode: 404 });

  const opsR = await pool.request()
    .input('pc',  sql.NVarChar(5), 'MX')
    .input('rid', sql.Int,         recordID)
    .query(`SELECT bo.IsPrimary, pu.Username,
                   COALESCE(NULLIF(RTRIM(ISNULL(pu.FirstName,'')+' '+ISNULL(pu.LastName,'')), ''), pu.Username) AS DisplayName
            FROM   prod.BatchOperators bo
            JOIN   Nexus.dbo.PortalUsers pu ON pu.UserID = bo.UserID
            WHERE  bo.ProcessCode = @pc AND bo.ProcessRecordID = @rid
              AND  bo.RemovedAt IS NULL
            ORDER  BY bo.IsPrimary DESC, bo.AssignedAt`);

  const tubsR = await pool.request()
    .input('id', sql.Int, recordID)
    .query(`SELECT TubID, TubSeq, SupplierTubNo, TubWeightKG, MaterialDocumentSAP, SAPSuccess
            FROM   prod.MixingTubs
            WHERE  MixingID = @id
            ORDER  BY TubSeq`);

  return { rec, operators: opsR.recordset, tubs: tubsR.recordset };
}

// tubSeq (optional): when given, reprint just that one tub's label instead
// of the whole batch's tub run — the reprint UI previously always sent every
// tub to the printer with no way to pick just the one that actually needs
// reprinting (e.g. a single label that jammed/smudged), which either wasted
// labels on the rest of the batch or forced someone to manually intercept
// the ones they didn't want. Matches on prod.MixingTubs.TubSeq (the number
// shown as "Tub" in the tubs modal/table and embedded in the printed
// batchRef's "-T{n}" suffix), not TubID.
async function fetchMixingTicketsData(recordID, tubSeq = null) {
  const { rec, operators, tubs: allTubs } = await fetchMixingHeader(recordID);
  const baseBatchRef = rec.BatchRef || `MX${String(recordID).padStart(8, '0')}`;
  const isComplete   = rec.Status === 4;

  let tubs = allTubs;
  if (tubSeq != null) {
    tubs = allTubs.filter(t => t.TubSeq === tubSeq);
    if (!tubs.length)
      throw Object.assign(new Error(`Tub ${tubSeq} not found on this mixing batch.`), { statusCode: 404 });
  }

  const shared = {
    processCode:     'MX',
    processName:     PROC.MX.name,
    status:          rec.Status,
    material:        rec.Material || '—',
    machine:         null,
    operators,
    createdAt:       rec.CreatedAt,
    completedAt:     rec.CompletedAt,
    uom:             PROC.MX.uom,
    parentBatches:   [],
    notes:           rec.Notes || null,
    supplierBatchNo: rec.SupplierBatchNo || null,
  };

  if (!tubs.length) {
    // No tub rows yet (legacy record, or printed before any tub was
    // weighed) — one ticket for the whole batch so printing never
    // silently produces nothing. (Only reachable when tubSeq wasn't
    // specified — the filtered-empty case above already threw.)
    return [{
      ...shared,
      batchRef:      baseBatchRef,
      quantity:      null,
      sapMatDoc:     null,
      supplierTubNo: null,
    }];
  }

  return tubs.map(t => ({
    ...shared,
    batchRef:      `${baseBatchRef}-T${t.TubSeq}`,
    quantity:      t.TubWeightKG,
    sapMatDoc:     isComplete && t.SAPSuccess && t.MaterialDocumentSAP ? t.MaterialDocumentSAP : null,
    supplierTubNo: t.SupplierTubNo || null,
  }));
}

// ── Pallet builder — batch scan confirmation ────────────────────────────────
// One per log.PalletPackages row that actually carries a SAP batch (not the
// PC2007 outer-box container rows, which have no batch of their own) —
// printed the moment a batch is scanned/staged onto a pallet, so the
// operator gets an immediate, from-a-distance visual that it's already
// spoken for rather than having to check the app.
async function fetchPalletScanData(palletItemID) {
  const pool = await getNexusOperationsPool();
  const r = await pool.request()
    .input('id', sql.Int, palletItemID)
    .query(`SELECT pp.palletItemID, pp.palletID, pp.packagingID, pp.palletLayer,
                   pp.sapMaterial, pp.sapQuantity, pp.sapBatch, pp.sapDelivery,
                   pp.scanTime, pkg.packDescription,
                   pm.palletType, pm.palletLocation,
                   dest.destinationName
            FROM   log.PalletPackages pp
            JOIN   log.PalletMain pm        ON pm.palletID = pp.palletID
            LEFT JOIN log.PackagingData pkg ON pkg.packID = pp.packagingID
            LEFT JOIN log.DeliveryMain  dm  ON dm.deliveryID = TRY_CONVERT(bigint, pp.sapDelivery)
            LEFT JOIN log.Destinations  dest ON dest.destinationID = dm.customerID
            WHERE  pp.palletItemID = @id`);
  const rec = r.recordset[0];
  if (!rec) throw Object.assign(new Error('Pallet package not found.'), { statusCode: 404 });
  if (!rec.sapBatch) throw Object.assign(new Error('This package has no batch to confirm — nothing to print.'), { statusCode: 400 });

  return {
    palletItemID:    rec.palletItemID,
    palletID:        rec.palletID,
    batch:           rec.sapBatch,
    material:        rec.sapMaterial || '—',
    quantity:        rec.sapQuantity,
    packagingID:     rec.packagingID || null,
    packDescription: rec.packDescription || null,
    palletLayer:     rec.palletLayer,
    deliveryId:      rec.sapDelivery || null,
    customerName:    rec.destinationName || null,
    palletType:      rec.palletType || null,
    palletLocation:  rec.palletLocation || null,
    scanTime:        rec.scanTime,
  };
}

// ── Pallet builder — pallet finish manifest ─────────────────────────────────
// Printed once a pallet is marked finished — lists every material on it
// (one summary row per material, quantity summed and batches concatenated,
// rather than one row per PalletPackages record — a material picked across
// several batches would otherwise repeat), plus the customer/delivery it's
// destined for. A pallet can only ever be on one delivery in practice (the
// builder is opened from a single picksheet's pallet list), but
// log.DeliveryLink's PK is (deliveryID, palletID) rather than a pallet-owns
// FK, so this takes the lowest deliveryID rather than assuming there's
// exactly one row.
async function fetchPalletFinishData(palletID) {
  const pool = await getNexusOperationsPool();

  const palR = await pool.request()
    .input('id', sql.Int, palletID)
    .query(`SELECT pm.palletID, pm.palletType, pm.palletLocation, pm.grossWeight,
                   pm.palletFinishDate, ptd.palletDescription
            FROM   log.PalletMain pm
            LEFT JOIN log.PalletData ptd ON ptd.palletID = pm.palletType
            WHERE  pm.palletID = @id`);
  const pal = palR.recordset[0];
  if (!pal) throw Object.assign(new Error('Pallet not found.'), { statusCode: 404 });

  const delR = await pool.request()
    .input('id', sql.Int, palletID)
    .query(`SELECT TOP 1 dl.deliveryID, dest.destinationName
            FROM   log.DeliveryLink dl
            JOIN   log.DeliveryMain dm      ON dm.deliveryID = dl.deliveryID
            LEFT JOIN log.Destinations dest ON dest.destinationID = dm.customerID
            WHERE  dl.palletID = @id
            ORDER  BY dl.deliveryID`);
  const del = delR.recordset[0] || {};

  const itemsR = await pool.request()
    .input('id', sql.Int, palletID)
    .query(`SELECT pp.sapMaterial, pp.sapBatch, pp.sapQuantity, pp.packagingID
            FROM   log.PalletPackages pp
            WHERE  pp.palletID = @id AND pp.sapMaterial IS NOT NULL
            ORDER  BY pp.palletLayer, pp.palletItemID`);

  const byMaterial = new Map();
  for (const row of itemsR.recordset) {
    if (!byMaterial.has(row.sapMaterial)) {
      byMaterial.set(row.sapMaterial, {
        material: row.sapMaterial, packagingID: row.packagingID, qty: 0, batches: [],
      });
    }
    const entry = byMaterial.get(row.sapMaterial);
    entry.qty += Number(row.sapQuantity || 0);
    if (row.sapBatch) entry.batches.push(row.sapBatch);
  }

  return {
    palletID:          pal.palletID,
    palletType:        pal.palletType || null,
    palletDescription: pal.palletDescription || null,
    palletLocation:    pal.palletLocation || null,
    grossWeight:       pal.grossWeight,
    finishedAt:        pal.palletFinishDate,
    deliveryId:        del.deliveryID || null,
    customerName:      del.destinationName || null,
    items:             [...byMaterial.values()],
  };
}

// ── PDF builder (used for server-side printing) ───────────────────────────────
//
// The label artwork itself is always laid out at A5-landscape dimensions
// (595 x 420pt) — that never changes. What changes per printer is the
// physical PAGE the PDF declares, driven by `paperSize` (from the matching
// entry in config.json's "printers" array, default 'A5' if unset/unknown):
//   - 'A5': page = A5 landscape (595 x 420pt) — the label fills the whole
//     sheet, since that's the paper actually loaded.
//   - 'A4': page = A4 portrait (595 x 842pt) — note A4-portrait width and
//     A5-landscape width are both exactly 595pt (A5 is precisely half an
//     A4 sheet), so every x-coordinate below is unaffected either way. Only
//     the page's usable HEIGHT differs, and the fixed content height (420pt)
//     is deliberately kept separate from the page height so the label draws
//     into the top half of the A4 sheet, leaving the bottom half blank,
//     rather than being stretched/scaled to fill the whole page (the bug
//     being fixed here — sending an A5-sized PDF to a printer loaded with
//     A4 stock was leaving it to the printer's own fit-to-page/RIP scaling
//     to decide how to fill the sheet, which is what produced the
//     landscape-and-fills-the-whole-page symptom).
// Any other/unrecognised paperSize value falls back to 'A5' behaviour.
async function buildPDF(data, paperSize = 'A5') {
  return buildLabelsPDF([data], paperSize);
}

// Draws one label onto the PDFDocument's current page. Split out of
// buildPDF so a Mixing ticket run (multiple tubs) can call this once per
// page of a single PDFDocument/tcpPrint job instead of reconnecting to the
// printer per tub — see buildLabelsPDF below.
async function drawLabelPage(doc, data, isA4) {
      // Real A4 printers (standard laser/MFP trays, unlike the A5 label
      // stock this was originally designed for) have a hardware minimum
      // margin — commonly ~4-5mm on every edge — that the print engine
      // physically cannot image into, regardless of what the PDF page
      // declares. With `margin: 0` above and the header drawn starting at
      // y=0, that band fell inside the unprintable zone and was silently
      // clipped: the reported "top of the label is cut off, doesn't have
      // the header" after switching printers from A5 to A4. Shifting the
      // whole coordinate system down by a safe margin fixes this without
      // touching the A5 branch, where labels print on die-cut/thermal
      // stock that images edge-to-edge and this was never a problem.
      const TOP_SAFE_MARGIN = 16; // ~5.6mm — comfortably covers common laser/MFP minimum margins
      if (isA4) doc.translate(0, TOP_SAFE_MARGIN);

      const W  = doc.page.width;   // ≈595 either way (A5 landscape width == A4 portrait width)
      const H  = 420;              // fixed content height (A5-equivalent) — NOT doc.page.height, so on A4 the label sits in the top half rather than stretching to fill the sheet
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

      const HALF = CW / 2;
      const xR   = M + HALF + 8;
      const colW = HALF - 10;   // per-column text/value width
      const BW   = Math.min(colW, 250);

      // ── Two independent column cursors ─────────────────────────────────────
      // Batch Reference/Material (left) and SAP Material Document/Operators/
      // Machine/Completed (right) are different lengths depending on the
      // record (e.g. SAP Material Document is blank until the batch backflushes),
      // so each column is laid out top-down on its own y cursor rather than
      // forcing both sides into lockstep rows. Per user's mockup: each
      // identifying value now appears as a big number ONCE, immediately
      // followed by its barcode — no separate small-text repeat of the same
      // value underneath the barcode like earlier iterations of this label had.
      let yL = HDR + 8;
      let yR = HDR + 8;

      // ── LEFT: Batch Reference ────────────────────────────────────────────────
      // Sized to the largest font that still fits a worst-case ref + tub
      // suffix ("MX00012345-T99", 14 chars) inside one column's width
      // (measured: 14 chars @ 32pt ≈ 256pt against a ~270pt safe budget).
      doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280')
         .text('BATCH REFERENCE', M, yL, { lineBreak: false });
      yL += 9;
      doc.font('Helvetica-Bold').fontSize(22).fillColor('#111827')
         .text(data.batchRef, M, yL, { width: colW, lineBreak: false });
      yL += 40;
      const bcRef = await barcodeBuffer(data.batchRef);
      if (bcRef) {
        doc.image(bcRef, M, yL, { width: BW });
        yL += renderedH(bcRef, BW) + 4;
      }
      doc.moveTo(M, yL).lineTo(M + HALF - 8, yL).strokeColor('#d1d5db').lineWidth(0.5).stroke();
      yL += 6;

      // ── LEFT: Material ────────────────────────────────────────────────────────
      // Material is NVARCHAR(18) (sql/create_production_database.sql) — 26pt
      // is the largest size an 18-char worst case still fits inside one
      // column's width (measured: 18 chars @ 26pt ≈ 260pt against the same
      // ~270pt budget).
      doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280')
         .text('MATERIAL', M, yL, { lineBreak: false });
      yL += 9;
      let matFontSize;
      if (data.material.length < 10) matFontSize = 56; else if (data.material.length < 13) matFontSize = 36; else matFontSize = 26;
      doc.font('Helvetica-Bold').fontSize(matFontSize).fillColor('#111827')
         .text(data.material, M, yL, { width: colW, lineBreak: false });
      yL += matFontSize;
      const bcMat = await barcodeBuffer(data.material);
      if (bcMat) {
        const mw = Math.min(colW, 160);
        doc.image(bcMat, M, yL, { width: mw });
        yL += renderedH(bcMat, mw) + 4;
      }

      // ── RIGHT: SAP Material Document ─────────────────────────────────────────
      // Only present once the batch has backflushed to SAP — MaterialDocumentSAP
      // is NVARCHAR(10), so 32pt (matching Batch Reference above for visual
      // symmetry) comfortably fits the 10-digit worst case with room to spare.
      const bcSap = (isComplete && data.sapMatDoc) ? await barcodeBuffer(data.sapMatDoc) : null;
      if (bcSap) {
        doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280')
           .text('SAP MATERIAL DOCUMENT', xR, yR, { lineBreak: false });
        yR += 9;
        doc.font('Helvetica-Bold').fontSize(22).fillColor('#111827')
           .text(data.sapMatDoc, xR, yR, { width: colW, lineBreak: false });
        yR += 40;
        doc.image(bcSap, xR, yR, { width: BW });
        yR += renderedH(bcSap, BW) + 4;
        doc.moveTo(xR, yR).lineTo(xR + HALF - 8, yR).strokeColor('#d1d5db').lineWidth(0.5).stroke();
        yR += 6;
      }

      // ── RIGHT: Operators / Machine / Completed ──────────────────────────────
      // Machine is only meaningful for the non-Mixing processes (Mixing has
      // no machine — fetchMixingTicketsData always sets it null) so it's
      // skipped entirely rather than printing a bare "—" on every Mixing tub
      // label.
      const primaryOp = data.operators.find(o => o.IsPrimary) || data.operators[0];
      const opList    = isComplete
        ? data.operators.map(o => o.DisplayName || o.Username).join(', ')
        : (primaryOp?.DisplayName || primaryOp?.Username || '—');

      doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280')
         .text(isComplete ? 'OPERATORS' : 'OPERATOR', xR, yR, { lineBreak: false });
      yR += 9;
      doc.font('Helvetica').fontSize(22).fillColor('#111827')
         .text(opList, xR, yR, { width: colW, lineBreak: false });
      yR += 11;

      if (data.machine) {
        doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280')
           .text('MACHINE', xR, yR, { lineBreak: false });
        yR += 9;
        doc.font('Helvetica-Bold').fontSize(22).fillColor('#111827')
           .text(data.machine, xR, yR, { width: colW, lineBreak: false });
        yR += 12;
      }

      doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280')
         .text(isComplete ? 'COMPLETED' : 'CREATED', xR, yR, { lineBreak: false });
      yR += 9;
      doc.font('Helvetica').fontSize(22).fillColor('#111827')
         .text(fmtLabel(isComplete ? data.completedAt : data.createdAt), xR, yR, { width: colW, lineBreak: false });
      yR += 11;

      // ── Below both columns: Input Batches, then Weight, then Notes ─────────
      // Full label width rather than squeezed into a column — traceability
      // for the non-Mixing processes can be several concatenated parent
      // batch refs (see data.parentBatches below) and needs the room.
      let y = Math.max(yL, yR);
      doc.moveTo(M, y).lineTo(W - M, y).strokeColor('#d1d5db').lineWidth(0.5).stroke();
      y += 6;

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
      y += 11;

      // ── Completion section ───────────────────────────────────────────────────
      if (isComplete) {
        doc.moveTo(M, y).lineTo(W - M, y).strokeColor('#d1d5db').lineWidth(0.5).stroke();
        y += 6;

        const qLabel = data.uom === 'KG' ? 'WEIGHT (KG)' : 'LENGTH (M)';
        const qValue = data.quantity != null ? `${Number(data.quantity).toFixed(3)} ${data.uom}` : '—';
        doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280')
           .text(qLabel, M, y, { lineBreak: false });
        y += 9;
        doc.font('Helvetica-Bold').fontSize(30).fillColor('#0d4c45')
           .text(qValue, M, y, { lineBreak: false });
        y += 33;

        if (data.notes) {
          doc.moveTo(M, y).lineTo(W - M, y).strokeColor('#d1d5db').lineWidth(0.5).stroke();
          y += 6;
          doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280')
             .text('NOTES', M, y, { lineBreak: false });
          y += 9;
          doc.font('Helvetica').fontSize(8).fillColor('#111827');
          // Belt-and-braces: this redesign leaves far more spare vertical
          // room than the earlier full-width-giant-row version did, but
          // PDFKit still doesn't clip overflowing text the way the HTML
          // preview's CSS (overflow:hidden) does, so keep the safety net —
          // trim to whatever height is actually available, with an
          // ellipsis, rather than ever risking text through the footer.
          let notesText = data.notes;
          const availH = (H - 14) - y - 2;
          if (availH > 0 && doc.heightOfString(notesText, { width: CW }) > availH) {
            let lo = 0, hi = notesText.length;
            while (lo < hi) {
              const mid = (lo + hi + 1) >> 1;
              if (doc.heightOfString(notesText.slice(0, mid) + '…', { width: CW }) <= availH) lo = mid; else hi = mid - 1;
            }
            notesText = lo > 0 ? notesText.slice(0, lo) + '…' : '';
          }
          if (notesText) doc.text(notesText, M, y, { width: CW });
        }
      }

      // ── Footer ───────────────────────────────────────────────────────────────
      doc.moveTo(0, H - 14).lineTo(W, H - 14).strokeColor('#0d4c45').lineWidth(2).stroke();
      doc.font('Helvetica').fontSize(6).fillColor('#9ca3af')
         .text(`Printed ${fmtLabel(new Date())}  ·  ${data.batchRef}`, M, H - 10,
               { width: CW, lineBreak: false });
}

// One PDFDocument, one page per label — used directly for a Mixing print
// run (one tub per page) and by buildPDF above for the single-label case.
// Sending the whole run as one PDF/one tcpPrint call means all of a batch's
// tub tickets come out of the printer together in one job, rather than
// reconnecting to the printer once per tub.
async function buildLabelsPDF(dataArray, paperSize = 'A5') {
  return new Promise(async (resolve, reject) => {
    try {
      const isA4 = String(paperSize).toUpperCase() === 'A4';
      const pageOpts = { size: isA4 ? 'A4' : 'A5', layout: isA4 ? 'portrait' : 'landscape', margin: 0 };
      const doc = new PDFDocument({
        ...pageOpts,
        info: {
          Title: dataArray.length > 1
            ? `${dataArray[0].processName} Labels — ${dataArray[0].batchRef.split('-T')[0]}`
            : `${dataArray[0].processName} Label — ${dataArray[0].batchRef}`,
          Author: 'Kongsberg Automotive',
        },
      });
      const chunks = [];
      doc.on('data',  c  => chunks.push(c));
      doc.on('end',   () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      for (let i = 0; i < dataArray.length; i++) {
        if (i > 0) doc.addPage(pageOpts);
        await drawLabelPage(doc, dataArray[i], isA4);
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// One-page PDF for a single warehouse label (batch-scan or pallet-finish),
// mirroring buildLabelsPDF's page-size/paperSize handling above but taking
// the draw function as a parameter since these two label kinds don't share
// drawLabelPage's production-record shape.
async function buildSingleLabelPDF(drawFn, data, paperSize = 'A5') {
  return new Promise(async (resolve, reject) => {
    try {
      const isA4 = String(paperSize).toUpperCase() === 'A4';
      const pageOpts = { size: isA4 ? 'A4' : 'A5', layout: isA4 ? 'portrait' : 'landscape', margin: 0 };
      const doc = new PDFDocument({ ...pageOpts, info: { Author: 'Kongsberg Automotive' } });
      const chunks = [];
      doc.on('data',  c  => chunks.push(c));
      doc.on('end',   () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      await drawFn(doc, data, isA4);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Batch scan confirmation — single value (the batch) big and barcoded, same
// as the production label's Batch Reference, plus where it's now spoken
// for (pallet/pickheet/customer) so it reads at a glance from a distance.
async function drawPalletScanLabel(doc, data, isA4) {
  const TOP_SAFE_MARGIN = 16; // see drawLabelPage's header comment above
  if (isA4) doc.translate(0, TOP_SAFE_MARGIN);

  const W    = doc.page.width;
  const H    = 420;
  const M    = 12;
  const CW   = W - 2 * M;
  const HALF = CW / 2;
  const xR   = M + HALF + 8;
  const colW = HALF - 10;
  const BW   = Math.min(colW, 250);

  const HDR = 38;
  doc.rect(0, 0, W, HDR).fill(WH_COLOR);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#ffffff')
     .text('KONGSBERG AUTOMOTIVE', M, 8, { lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor('rgba(255,255,255,0.75)')
     .text('WAREHOUSE — BATCH SCAN CONFIRMATION', M, 24, { lineBreak: false });

  doc.font('Helvetica-Bold').fontSize(7);
  const badgeText = 'ON PICKSHEET';
  const bdgTW = doc.widthOfString(badgeText);
  const bdgW  = bdgTW + 16, bdgH = 18, bdgX = W - M - bdgTW - 16, bdgY = 10;
  doc.roundedRect(bdgX, bdgY, bdgW, bdgH, 3).fill('#ffffff');
  doc.fillColor(WH_COLOR).text(badgeText, bdgX, bdgY + 5, { width: bdgW, align: 'center', lineBreak: false });

  let yL = HDR + 10;
  let yR = HDR + 10;

  // LEFT: Batch
  doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280').text('BATCH', M, yL, { lineBreak: false });
  yL += 9;
  doc.font('Helvetica-Bold').fontSize(32).fillColor('#111827').text(data.batch, M, yL, { width: colW, lineBreak: false });
  yL += 42;
  const bcBatch = await barcodeBuffer(data.batch);
  if (bcBatch) { doc.image(bcBatch, M, yL, { width: BW }); yL += renderedH(bcBatch, BW) + 4; }
  doc.moveTo(M, yL).lineTo(M + HALF - 8, yL).strokeColor('#d1d5db').lineWidth(0.5).stroke();
  yL += 8;

  // LEFT: Material
  doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280').text('MATERIAL', M, yL, { lineBreak: false });
  yL += 9;
  const matFS = data.material.length < 10 ? 30 : data.material.length < 13 ? 24 : 18;
  doc.font('Helvetica-Bold').fontSize(matFS).fillColor('#111827').text(data.material, M, yL, { width: colW, lineBreak: false });
  yL += matFS + 4;
  if (data.packDescription) {
    doc.font('Helvetica').fontSize(8).fillColor('#4b5563').text(data.packDescription, M, yL, { width: colW, lineBreak: false });
    yL += 12;
  }

  // RIGHT: Pallet / pickheet / customer / location
  doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280').text('PALLET', xR, yR, { lineBreak: false });
  yR += 9;
  doc.font('Helvetica-Bold').fontSize(22).fillColor(WH_COLOR).text(`#${data.palletID}`, xR, yR, { width: colW, lineBreak: false });
  yR += 26;

  doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280').text('PICKSHEET / DELIVERY', xR, yR, { lineBreak: false });
  yR += 9;
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#111827').text(data.deliveryId || '—', xR, yR, { width: colW, lineBreak: false });
  yR += 24;

  doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280').text('CUSTOMER', xR, yR, { lineBreak: false });
  yR += 9;
  doc.font('Helvetica').fontSize(14).fillColor('#111827').text(data.customerName || '—', xR, yR, { width: colW, lineBreak: false });
  yR += 20;

  doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280').text('LOCATION', xR, yR, { lineBreak: false });
  yR += 9;
  doc.font('Helvetica').fontSize(14).fillColor('#111827').text(data.palletLocation || '—', xR, yR, { width: colW, lineBreak: false });
  yR += 18;

  // Below both columns: quantity staged + layer/packaging
  let y = Math.max(yL, yR);
  doc.moveTo(M, y).lineTo(W - M, y).strokeColor('#d1d5db').lineWidth(0.5).stroke();
  y += 8;

  const qtyLabel = data.quantity != null ? Number(data.quantity).toFixed(3) : '—';
  doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280').text('QUANTITY STAGED', M, y, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280').text('LAYER', xR, y, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280').text('PACKAGING', xR + colW / 2, y, { lineBreak: false });
  y += 9;
  doc.font('Helvetica-Bold').fontSize(26).fillColor(WH_COLOR).text(qtyLabel, M, y, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#111827').text(String(data.palletLayer ?? '—'), xR, y, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#111827').text(data.packagingID || '—', xR + colW / 2, y, { lineBreak: false });

  doc.moveTo(0, H - 14).lineTo(W, H - 14).strokeColor(WH_COLOR).lineWidth(2).stroke();
  doc.font('Helvetica').fontSize(6).fillColor('#9ca3af')
     .text(`Printed ${fmtLabel(new Date())}  ·  Scanned ${fmtLabel(data.scanTime)}  ·  ${data.batch}`, M, H - 10, { width: CW, lineBreak: false });
}

// Pallet finish manifest — every material on the pallet (see
// fetchPalletFinishData's one-row-per-material grouping) in a small table,
// since unlike every other label here the thing being confirmed isn't a
// single value but a variable-length list. Row height/font shrink as the
// item count grows (same "trim to fit, don't overflow the footer" approach
// as drawLabelPage's Notes section above), with an overflow line rather
// than ever running text under the footer rule.
async function drawPalletFinishLabel(doc, data, isA4) {
  const TOP_SAFE_MARGIN = 16;
  if (isA4) doc.translate(0, TOP_SAFE_MARGIN);

  const W  = doc.page.width;
  const H  = 420;
  const M  = 12;
  const CW = W - 2 * M;

  const HDR = 38;
  doc.rect(0, 0, W, HDR).fill(WH_COLOR);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#ffffff')
     .text('KONGSBERG AUTOMOTIVE', M, 8, { lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor('rgba(255,255,255,0.75)')
     .text('WAREHOUSE — PALLET FINISH MANIFEST', M, 24, { lineBreak: false });

  doc.font('Helvetica-Bold').fontSize(7);
  const badgeText = 'COMPLETE';
  const bdgTW = doc.widthOfString(badgeText);
  const bdgW  = bdgTW + 16, bdgH = 18, bdgX = W - M - bdgTW - 16, bdgY = 10;
  doc.roundedRect(bdgX, bdgY, bdgW, bdgH, 3).fill('#15803d');
  doc.fillColor('#ffffff').text(badgeText, bdgX, bdgY + 5, { width: bdgW, align: 'center', lineBreak: false });

  const HALF = CW / 2;
  const xR   = M + HALF + 8;
  const colW = HALF - 10;
  const BW   = Math.min(colW, 200);

  let y = HDR + 10;

  doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280').text('PALLET', M, y, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280').text('CUSTOMER', xR, y, { lineBreak: false });
  y += 9;
  const palletRef = `#${data.palletID}`;
  doc.font('Helvetica-Bold').fontSize(24).fillColor('#111827').text(palletRef, M, y, { width: colW, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#111827').text(data.customerName || '—', xR, y, { width: colW, lineBreak: false });
  y += 28;

  const bcPallet = await barcodeBuffer(palletRef);
  let yLeftEnd = y;
  if (bcPallet) { doc.image(bcPallet, M, y, { width: BW }); yLeftEnd = y + renderedH(bcPallet, BW); }

  doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280').text('PICKSHEET / DELIVERY', xR, y, { lineBreak: false });
  y += 9;
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#111827').text(data.deliveryId || '—', xR, y, { width: colW, lineBreak: false });
  y += 16;
  doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280').text('LOCATION', xR, y, { lineBreak: false });
  y += 9;
  doc.font('Helvetica').fontSize(12).fillColor('#111827').text(data.palletLocation || '—', xR, y, { width: colW, lineBreak: false });
  y += 14;

  y = Math.max(yLeftEnd, y) + 6;
  doc.moveTo(M, y).lineTo(W - M, y).strokeColor(WH_COLOR).lineWidth(1).stroke();
  y += 8;

  // ── Contents table ─────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280')
     .text('MATERIAL',   M,               y, { lineBreak: false, width: CW * 0.4 })
     .text('BATCH(ES)',  M + CW * 0.4,    y, { lineBreak: false, width: CW * 0.4 })
     .text('QTY',        M + CW * 0.82,   y, { lineBreak: false, width: CW * 0.18, align: 'right' });
  y += 10;
  doc.moveTo(M, y).lineTo(W - M, y).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
  y += 3;

  const footerY = H - 48; // reserves the bottom stat strip (34pt) + footer rule/text (14pt)
  const avail   = footerY - y;
  const items   = data.items || [];
  let rowH = 14, fontSize = 8;
  if (items.length > 10) { rowH = 11; fontSize = 6.5; }
  if (items.length > 16) { rowH = 9;  fontSize = 6;   }
  const maxRows  = Math.max(1, Math.floor(avail / rowH));
  const shown    = items.slice(0, maxRows);
  const overflow = items.length - shown.length;

  doc.font('Helvetica').fontSize(fontSize).fillColor('#111827');
  for (const item of shown) {
    doc.text(item.material,                    M,             y, { lineBreak: false, width: CW * 0.4 })
       .text(item.batches.join(', ') || '—',   M + CW * 0.4,  y, { lineBreak: false, width: CW * 0.4 })
       .text(Number(item.qty).toFixed(0),      M + CW * 0.82, y, { lineBreak: false, width: CW * 0.18, align: 'right' });
    y += rowH;
  }
  if (overflow > 0) {
    doc.font('Helvetica-Oblique').fontSize(fontSize).fillColor('#6b7280')
       .text(`+ ${overflow} more item${overflow !== 1 ? 's' : ''}…`, M, y, { lineBreak: false });
  }

  // ── Bottom stat strip ────────────────────────────────────────────────────
  doc.moveTo(M, footerY).lineTo(W - M, footerY).strokeColor('#d1d5db').lineWidth(0.5).stroke();
  const statY = footerY + 5;
  doc.font('Helvetica-Bold').fontSize(6).fillColor('#6b7280')
     .text('GROSS WEIGHT', M,             statY, { lineBreak: false })
     .text('PALLET TYPE',  M + CW * 0.35, statY, { lineBreak: false })
     .text('FINISHED',     M + CW * 0.65, statY, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827')
     .text(data.grossWeight != null ? `${Number(data.grossWeight).toFixed(1)} kg` : '—', M, statY + 9, { lineBreak: false })
     .text(`${data.palletType || '—'}${data.palletDescription ? ' · ' + data.palletDescription : ''}`, M + CW * 0.35, statY + 9, { lineBreak: false, width: CW * 0.28 })
     .text(fmtLabel(data.finishedAt), M + CW * 0.65, statY + 9, { lineBreak: false });

  doc.moveTo(0, H - 14).lineTo(W, H - 14).strokeColor(WH_COLOR).lineWidth(2).stroke();
  doc.font('Helvetica').fontSize(6).fillColor('#9ca3af')
     .text(`Printed ${fmtLabel(new Date())}  ·  Pallet #${data.palletID}`, M, H - 10, { width: CW, lineBreak: false });
}

// ── HTML preview builder (used for browser preview tab) ───────────────────────
function bcImg(src, heightMm) {
  if (!src) return '';
  return `<img src="${src}" style="display:block;height:${heightMm}mm;width:auto;max-width:100%">`;
}

async function buildHTML(data) {
  return buildLabelsHTML([data]);
}

// Renders one label's <div class="label">...</div> block. Split out of
// buildHTML so a Mixing ticket run (multiple tubs) can render N of these
// into one preview page — see buildLabelsHTML below.
async function renderLabelDiv(data) {
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

  // Two independent columns (left: Batch Reference/Material, right: SAP
  // Material Document/Operators/Machine/Completed) laid out per the user's
  // mockup — each identifying value appears ONCE as a big number
  // immediately followed by its barcode, with no separate small-text
  // repeat underneath like earlier iterations of this label had. Machine
  // is only shown when present (Mixing tickets never have one — see
  // fetchMixingTicketsData, which always sets machine: null — so it's
  // skipped rather than printing a bare "—" on every Mixing tub label).
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

  return `
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
      <div class="col">
        <div class="lbl">BATCH REFERENCE</div>
        <div class="mix-id">${esc(data.batchRef)}</div>
        ${bcImg(b64(bcRef), 13)}
        <div class="divider"></div>
        <div class="lbl">MATERIAL</div>
        <div class="mat-id">${esc(data.material)}</div>
        ${bcImg(b64(bcMat), 9)}
      </div>
      <div class="col">
        ${isComplete && data.sapMatDoc ? `
        <div class="lbl">SAP MATERIAL DOCUMENT</div>
        <div class="mix-id">${esc(data.sapMatDoc)}</div>
        ${bcImg(b64(bcSap), 13)}
        <div class="divider"></div>` : ''}
        <div class="lbl">${isComplete ? 'OPERATORS' : 'OPERATOR'}</div>
        <div class="op-val">${opList}</div>
        ${data.machine ? `
        <div class="lbl">MACHINE</div>
        <div class="mach-val">${esc(data.machine)}</div>` : ''}
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
</div>`;
}

// Wraps N label divs (one per prod.MixingTubs row for an MX run, or just
// one for every other process) in a single preview page — shared head/
// style/print-trigger, one .label per printed page via the @media print
// page-break rule below.
async function buildLabelsHTML(dataArray) {
  const divs  = (await Promise.all(dataArray.map(renderLabelDiv))).join('\n');
  const first = dataArray[0];
  const title = dataArray.length > 1
    ? `${first.batchRef.split('-T')[0]} — ${first.processName} Labels (${dataArray.length})`
    : `${first.batchRef} — ${first.processName} Label`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(title)}</title>
<style>
  @page { size: 210mm 148mm; margin: 0; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 210mm; overflow: visible;
    font-family: Helvetica Neue, Helvetica, Arial, sans-serif;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .label { width: 210mm; height: 148mm; display: flex; flex-direction: column; overflow: hidden; }
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
  .col     { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  /* Batch/mix reference (left) + SAP Material Document (right) at 32pt, and
     Material (left, below batch reference) at 26pt — each appears ONCE as
     a big number immediately followed by its barcode, with no separate
     small-text repeat underneath like earlier iterations of this label
     had (per user's mockup). Sized to the largest font that still fits a
     worst-case value inside one column's width without wrapping:
     batch/SAP refs ("XX########[-T#]", ~10-14 chars, or
     MaterialDocumentSAP's 10-digit max) at 32pt, Material (NVARCHAR(18)
     max) at 26pt. */
  .mix-id  { font-size: 32pt; font-weight: 800; letter-spacing: 0.02em; line-height: 1.05; white-space: nowrap; overflow: hidden; }
  .mat-id  { font-size: 26pt; font-weight: 800; letter-spacing: 0.02em; line-height: 1.05; white-space: nowrap; overflow: hidden; margin-top: 2px; }
  .mach-val { font-size: 9pt; font-weight: 700; }
  .op-val   { font-size: 8pt; }
  .date-val { font-size: 8pt; }
  .trace-val { font-size: 8pt; }
  .qty      { font-size: 30pt; font-weight: 700; color: #0d4c45; margin-top: 1px; }
  .notes    { font-size: 7.5pt; }
  .footer   { border-top: 2px solid #0d4c45; padding: 2px 12px; font-size: 6pt; color: #9ca3af; flex-shrink: 0; }
  @media screen {
    html, body { display: flex; flex-direction: column; align-items: center; background: #e5e7eb; }
    .label { margin: 10px; box-shadow: 0 4px 20px rgba(0,0,0,0.2); }
  }
  @media print {
    .label { page-break-after: always; }
    .label:last-child { page-break-after: auto; }
  }
</style>
</head>
<body>
${divs}
<script>window.addEventListener('load', () => setTimeout(() => window.print(), 300));</script>
</body>
</html>`;
}

// Shared page shell for the two warehouse label previews below — same
// @page size / print-on-load behaviour as buildLabelsHTML's wrapper, kept
// separate rather than reused since neither warehouse label fits that
// function's two-column production-record class names (.mix-id/.mat-id
// etc.), and a .wh-table rule is needed for the finish manifest's contents
// list that production labels have no equivalent of.
function wrapLabelPage(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(title)}</title>
<style>
  @page { size: 210mm 148mm; margin: 0; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 210mm; overflow: visible;
    font-family: Helvetica Neue, Helvetica, Arial, sans-serif;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .label { width: 210mm; height: 148mm; display: flex; flex-direction: column; overflow: hidden; }
  .header { color: #fff; padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
  .co-name { font-size: 11pt; font-weight: 700; letter-spacing: 0.02em; }
  .co-proc { font-size: 7.5pt; opacity: 0.75; margin-top: 2px; }
  .badge   { font-size: 7pt; font-weight: 700; color: #fff; padding: 3px 9px; border-radius: 4px; white-space: nowrap; }
  .body    { flex: 1; overflow: hidden; padding: 6px 12px 2px; display: flex; flex-direction: column; gap: 4px; }
  .lbl     { font-size: 5.5pt; font-weight: 700; color: #6b7280; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 2px; }
  .divider { border: none; border-top: 0.5px solid #d1d5db; margin: 2px 0; flex-shrink: 0; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
  .col     { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .mix-id  { font-size: 30pt; font-weight: 800; letter-spacing: 0.02em; line-height: 1.05; white-space: nowrap; overflow: hidden; }
  .mat-id  { font-size: 24pt; font-weight: 800; letter-spacing: 0.02em; line-height: 1.05; white-space: nowrap; overflow: hidden; margin-top: 2px; }
  .mach-val { font-size: 10pt; font-weight: 700; }
  .op-val   { font-size: 9pt; }
  .qty      { font-size: 28pt; font-weight: 700; margin-top: 1px; }
  .footer   { border-top: 2px solid #000; padding: 2px 12px; font-size: 6pt; color: #9ca3af; flex-shrink: 0; }
  .wh-table { width: 100%; border-collapse: collapse; font-size: 7.5pt; }
  .wh-table th { text-align: left; font-size: 5.5pt; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; border-bottom: 1px solid #d1d5db; padding: 2px 4px; }
  .wh-table td { padding: 2px 4px; border-bottom: 0.5px solid #e5e7eb; }
  @media screen {
    html, body { display: flex; flex-direction: column; align-items: center; background: #e5e7eb; }
    .label { margin: 10px; box-shadow: 0 4px 20px rgba(0,0,0,0.2); }
  }
</style>
</head>
<body>
${bodyHtml}
<script>window.addEventListener('load', () => setTimeout(() => window.print(), 300));</script>
</body>
</html>`;
}

async function buildPalletScanHTML(data) {
  const bcBatch = await barcodeBuffer(data.batch);
  const b64     = buf => buf ? `data:image/png;base64,${buf.toString('base64')}` : null;
  const qtyLabel = data.quantity != null ? Number(data.quantity).toFixed(3) : '—';

  const body = `
<div class="label">
  <div class="header" style="background:${WH_COLOR}">
    <div>
      <div class="co-name">KONGSBERG AUTOMOTIVE</div>
      <div class="co-proc">WAREHOUSE — BATCH SCAN CONFIRMATION</div>
    </div>
    <div class="badge" style="background:#ffffff;color:${WH_COLOR}">ON PICKSHEET</div>
  </div>
  <div class="body">
    <div class="two-col">
      <div class="col">
        <div class="lbl">BATCH</div>
        <div class="mix-id">${esc(data.batch)}</div>
        ${bcImg(b64(bcBatch), 13)}
        <div class="divider"></div>
        <div class="lbl">MATERIAL</div>
        <div class="mat-id">${esc(data.material)}</div>
        ${data.packDescription ? `<div class="op-val">${esc(data.packDescription)}</div>` : ''}
      </div>
      <div class="col">
        <div class="lbl">PALLET</div>
        <div class="mix-id" style="font-size:22pt;color:${WH_COLOR}">#${esc(String(data.palletID))}</div>
        <div class="lbl">PICKSHEET / DELIVERY</div>
        <div class="mach-val">${esc(data.deliveryId || '—')}</div>
        <div class="lbl">CUSTOMER</div>
        <div class="op-val">${esc(data.customerName || '—')}</div>
        <div class="lbl">LOCATION</div>
        <div class="op-val">${esc(data.palletLocation || '—')}</div>
      </div>
    </div>
    <div class="divider"></div>
    <div class="two-col">
      <div>
        <div class="lbl">QUANTITY STAGED</div>
        <div class="qty" style="color:${WH_COLOR}">${qtyLabel}</div>
      </div>
      <div>
        <div class="lbl">LAYER ${esc(String(data.palletLayer ?? '—'))} &nbsp;·&nbsp; PACKAGING ${esc(data.packagingID || '—')}</div>
      </div>
    </div>
  </div>
  <div class="footer" style="border-top:2px solid ${WH_COLOR}">Printed ${esc(fmtLabel(new Date()))} &nbsp;·&nbsp; Scanned ${esc(fmtLabel(data.scanTime))} &nbsp;·&nbsp; ${esc(data.batch)}</div>
</div>`;

  return wrapLabelPage(`${data.batch} — Batch Scan Confirmation`, body);
}

async function buildPalletFinishHTML(data) {
  const bcPallet = await barcodeBuffer(`#${data.palletID}`);
  const b64      = buf => buf ? `data:image/png;base64,${buf.toString('base64')}` : null;
  const items    = data.items || [];
  const rows = items.map(it => `
    <tr>
      <td>${esc(it.material)}</td>
      <td>${esc(it.batches.join(', ') || '—')}</td>
      <td style="text-align:right">${Number(it.qty).toFixed(0)}</td>
    </tr>`).join('');

  const body = `
<div class="label">
  <div class="header" style="background:${WH_COLOR}">
    <div>
      <div class="co-name">KONGSBERG AUTOMOTIVE</div>
      <div class="co-proc">WAREHOUSE — PALLET FINISH MANIFEST</div>
    </div>
    <div class="badge" style="background:#15803d">COMPLETE</div>
  </div>
  <div class="body">
    <div class="two-col">
      <div class="col">
        <div class="lbl">PALLET</div>
        <div class="mix-id">#${esc(String(data.palletID))}</div>
        ${bcImg(b64(bcPallet), 11)}
      </div>
      <div class="col">
        <div class="lbl">CUSTOMER</div>
        <div class="mach-val">${esc(data.customerName || '—')}</div>
        <div class="lbl">PICKSHEET / DELIVERY</div>
        <div class="op-val">${esc(data.deliveryId || '—')}</div>
        <div class="lbl">LOCATION</div>
        <div class="op-val">${esc(data.palletLocation || '—')}</div>
      </div>
    </div>
    <div class="divider"></div>
    <div class="lbl">CONTENTS (${items.length} material${items.length !== 1 ? 's' : ''})</div>
    <table class="wh-table">
      <thead><tr><th>Material</th><th>Batch(es)</th><th style="text-align:right">Qty</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3">No items</td></tr>'}</tbody>
    </table>
    <div class="divider"></div>
    <div class="two-col">
      <div><div class="lbl">GROSS WEIGHT</div><div class="mach-val">${data.grossWeight != null ? esc(Number(data.grossWeight).toFixed(1)) + ' kg' : '—'}</div></div>
      <div><div class="lbl">PALLET TYPE</div><div class="mach-val">${esc(data.palletType || '—')}${data.palletDescription ? ' · ' + esc(data.palletDescription) : ''}</div></div>
    </div>
  </div>
  <div class="footer" style="border-top:2px solid ${WH_COLOR}">Printed ${esc(fmtLabel(new Date()))} &nbsp;·&nbsp; Finished ${esc(fmtLabel(data.finishedAt))} &nbsp;·&nbsp; Pallet #${data.palletID}</div>
</div>`;

  return wrapLabelPage(`Pallet #${data.palletID} — Finish Manifest`, body);
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
      const pool = await getNexusPool();
      const r = await pool.request()
        .input('uid', sql.Int, uid)
        .query(`SELECT DefaultPrinterID FROM dbo.PortalUsers WHERE UserID = @uid`);
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
    const pool = await getNexusPool();
    await pool.request()
      .input('uid', sql.Int,           uid)
      .input('pid', sql.NVarChar(50),  printerId || null)
      .query(`UPDATE dbo.PortalUsers SET DefaultPrinterID = @pid WHERE UserID = @uid`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Browser preview (opens in new tab, auto-prints via window.print())
// ?tub=<TubSeq> (MX only) — reprint just that one tub instead of the whole
// batch's tub run. See fetchMixingTicketsData's header comment.
router.get('/process/:processCode/:recordID', async (req, res) => {
  const code     = req.params.processCode.toUpperCase();
  const recordID = Number(req.params.recordID);
  if (!SUPPORTED.has(code)) return res.status(400).json({ error: `Label not supported for ${code}.` });
  if (!recordID)            return res.status(400).json({ error: 'Invalid record ID.' });
  const tubSeq = req.query.tub != null && req.query.tub !== '' ? Number(req.query.tub) : null;
  try {
    // MX prints one ticket per tub (each with its own weight/SAP material
    // document) instead of one combined-batch ticket — see
    // fetchMixingTicketsData's header comment.
    const html = code === 'MX'
      ? await buildLabelsHTML(await fetchMixingTicketsData(recordID, tubSeq))
      : await buildHTML(await fetchLabelData(code, recordID));
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.send(html);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Server-side print — generates PDF and sends directly to network printer
// body.tub (MX only) — same single-tub reprint as the preview route above.
router.post('/process/:processCode/:recordID/print', async (req, res) => {
  const code     = req.params.processCode.toUpperCase();
  const recordID = Number(req.params.recordID);
  if (!SUPPORTED.has(code)) return res.status(400).json({ error: `Label not supported for ${code}.` });
  if (!recordID)            return res.status(400).json({ error: 'Invalid record ID.' });

  const { printerId, tub } = req.body;
  const tubSeq = tub != null && tub !== '' ? Number(tub) : null;
  const printer = printerId
    ? printersConfig.find(p => p.id === printerId)
    : printersConfig[0];

  if (!printer)
    return res.status(400).json({ error: printersConfig.length === 0
      ? 'No printers configured. Add a "printers" array to config.json.'
      : `Printer "${printerId}" not found.` });

  try {
    // Same MX fan-out as the preview route above — one PDF page (one
    // tcpPrint job) per tub rather than a single combined-batch label,
    // unless tubSeq narrows it down to just one.
    const pdf = code === 'MX'
      ? await buildLabelsPDF(await fetchMixingTicketsData(recordID, tubSeq), printer.paperSize)
      : await buildPDF(await fetchLabelData(code, recordID), printer.paperSize);
    await tcpPrint(pdf, printer.host, printer.port ?? 9100);
    res.json({ success: true, message: `Sent to ${printer.name || printer.host}` });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ── Pallet builder labels ───────────────────────────────────────────────────
// Browser preview — batch scan confirmation
router.get('/pallet/scan/:palletItemId', async (req, res) => {
  const id = Number(req.params.palletItemId);
  if (!id) return res.status(400).json({ error: 'Invalid pallet item ID.' });
  try {
    const html = await buildPalletScanHTML(await fetchPalletScanData(id));
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.send(html);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Server-side print — batch scan confirmation
router.post('/pallet/scan/:palletItemId/print', async (req, res) => {
  const id = Number(req.params.palletItemId);
  if (!id) return res.status(400).json({ error: 'Invalid pallet item ID.' });

  const { printerId } = req.body;
  const printer = printerId
    ? printersConfig.find(p => p.id === printerId)
    : printersConfig[0];

  if (!printer)
    return res.status(400).json({ error: printersConfig.length === 0
      ? 'No printers configured. Add a "printers" array to config.json.'
      : `Printer "${printerId}" not found.` });

  try {
    const data = await fetchPalletScanData(id);
    const pdf  = await buildSingleLabelPDF(drawPalletScanLabel, data, printer.paperSize);
    await tcpPrint(pdf, printer.host, printer.port ?? 9100);
    res.json({ success: true, message: `Sent to ${printer.name || printer.host}` });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// Browser preview — pallet finish manifest
router.get('/pallet/finish/:palletId', async (req, res) => {
  const id = Number(req.params.palletId);
  if (!id) return res.status(400).json({ error: 'Invalid pallet ID.' });
  try {
    const html = await buildPalletFinishHTML(await fetchPalletFinishData(id));
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.send(html);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Server-side print — pallet finish manifest
router.post('/pallet/finish/:palletId/print', async (req, res) => {
  const id = Number(req.params.palletId);
  if (!id) return res.status(400).json({ error: 'Invalid pallet ID.' });

  const { printerId } = req.body;
  const printer = printerId
    ? printersConfig.find(p => p.id === printerId)
    : printersConfig[0];

  if (!printer)
    return res.status(400).json({ error: printersConfig.length === 0
      ? 'No printers configured. Add a "printers" array to config.json.'
      : `Printer "${printerId}" not found.` });

  try {
    const data = await fetchPalletFinishData(id);
    const pdf  = await buildSingleLabelPDF(drawPalletFinishLabel, data, printer.paperSize);
    await tcpPrint(pdf, printer.host, printer.port ?? 9100);
    res.json({ success: true, message: `Sent to ${printer.name || printer.host}` });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

export default router;
