// ── Consignment Declaration PDF builder ─────────────────────────────────────
//
// Printable declaration to send to a consignment vendor (Chemours/Fothergill
// (FCF)/Raaj) showing exactly which delivery line/invoice/batch a
// declaration run allocates consumption against — the matrix Raaj's old
// workbook (Summary tab) always showed after the fact via MRKO, produced
// here before MRKO is even run. See routes/consignmentsql.js's
// buildAllocationProposal and sql/migrate_consignment_tracker.sql's header
// for the full design writeup.
//
// Same pdfkit convention as lib/poPdf.js — the only other "real document"
// PDF builder in this repo.
import PDFDocument from 'pdfkit';

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtQty(n) {
  const num = Number(n);
  return Number.isFinite(num) ? num.toLocaleString('en-GB', { maximumFractionDigits: 3 }) : String(n ?? '—');
}

const KONGSBERG_NAME = 'Kongsberg Actuation System Ltd';

/**
 * @param {object} data
 * @param {number} data.declarationId
 * @param {string} data.vendorName
 * @param {string} [data.sapVendorNumber]
 * @param {string} data.status
 * @param {string} data.allocationMethod
 * @param {number} data.totalQty
 * @param {string|Date} data.createdAtUtc
 * @param {string} [data.settlementDocumentNumber]
 * @param {Array<{material:string, invoiceNumber?:string, materialDocument?:string, expiryDate?:string|Date, documentDate?:string|Date, qtyAllocated:number, uom?:string}>} data.lines
 * @param {Array<{material:string, startingStock:number, deliveries:number, consumption:number, endingStock:number}>} [data.materialSummaries]
 *   Per-material Starting Stock / Deliveries / Consumption / Ending Stock,
 *   since that material's previous Confirmed declaration — see
 *   routes/consignmentsql.js's getConsignmentDeclarationStockSummary.
 * @returns {Promise<Buffer>}
 */
export async function buildConsignmentDeclarationPdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4', layout: 'portrait', margin: 40,
        info: { Title: `Consignment Declaration ${data.declarationId}`, Author: 'Kongsberg Automotive' },
        bufferPages: true,
      });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width;
      const M = 40;
      const CW = W - 2 * M;

      // ── Header band ──────────────────────────────────────────────────────
      doc.rect(0, 0, W, 60).fill('#0d4c45');
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#ffffff')
         .text('KONGSBERG AUTOMOTIVE', M, 18, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(18).fillColor('#ffffff')
         .text('CONSIGNMENT DECLARATION', M, 0, { width: CW, align: 'right', lineBreak: false });
      doc.font('Helvetica').fontSize(10).fillColor('rgba(255,255,255,0.8)')
         .text(`Declaration #${data.declarationId}`, M, 24, { width: CW, align: 'right', lineBreak: false });

      let y = 80;
      const colW = CW / 3 - 8;

      doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280').text('SUPPLIER', M, y, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827')
         .text(data.vendorName || '—', M, y + 12, { width: colW, lineBreak: true });
      if (data.sapVendorNumber) {
        doc.font('Helvetica').fontSize(9).fillColor('#6b7280')
           .text(`SAP Vendor ${data.sapVendorNumber}`, M, y + 30, { width: colW, lineBreak: false });
      }

      const col2X = M + colW + 12;
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280').text('DECLARATION DATE', col2X, y, { lineBreak: false });
      doc.font('Helvetica').fontSize(10).fillColor('#111827')
         .text(fmtDate(data.createdAtUtc), col2X, y + 12, { width: colW, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280').text('ALLOCATION METHOD', col2X, y + 32, { lineBreak: false });
      doc.font('Helvetica').fontSize(10).fillColor('#111827')
         .text(data.allocationMethod || '—', col2X, y + 44, { width: colW, lineBreak: false });

      const col3X = M + 2 * colW + 24;
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280').text('STATUS', col3X, y, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827')
         .text(data.status || '—', col3X, y + 12, { width: colW, lineBreak: false });
      if (data.settlementDocumentNumber) {
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280').text('SAP SETTLEMENT DOC', col3X, y + 32, { lineBreak: false });
        doc.font('Helvetica').fontSize(10).fillColor('#111827')
           .text(data.settlementDocumentNumber, col3X, y + 44, { width: colW, lineBreak: false });
      }

      y += 100;
      doc.moveTo(M, y).lineTo(W - M, y).strokeColor('#0d4c45').lineWidth(1.5).stroke();
      y += 16;

      // ── Stock Summary — per material, since that material's previous
      // Confirmed declaration (or the beginning of the vendor relationship
      // if none). Opening + Deliveries − Consumption = Closing, same shape
      // as the old per-vendor workbooks this feature replaces. ────────────
      const summaries = data.materialSummaries || [];
      if (summaries.length) {
        const sumCols = [
          { key: 'material', label: 'Material', w: CW * 0.24 },
          { key: 'starting', label: 'Starting Stock', w: CW * 0.19, align: 'right' },
          { key: 'delivered', label: 'Deliveries', w: CW * 0.19, align: 'right' },
          { key: 'consumed', label: 'Consumption', w: CW * 0.19, align: 'right' },
          { key: 'ending', label: 'Ending Stock', w: CW * 0.19, align: 'right' },
        ];
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280').text('STOCK SUMMARY', M, y, { lineBreak: false });
        y += 12;

        const sumRowH = 18;
        doc.rect(M, y, CW, sumRowH).fill('#f3f4f6');
        let sx = M;
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#374151');
        for (const c of sumCols) {
          doc.text(c.label.toUpperCase(), sx + 4, y + 5, { width: c.w - 8, align: c.align || 'left', lineBreak: false });
          sx += c.w;
        }
        y += sumRowH;

        for (const s of summaries) {
          sx = M;
          doc.font('Helvetica').fontSize(8.5).fillColor('#111827');
          const vals = {
            material: s.material || '',
            starting: fmtQty(s.startingStock),
            delivered: fmtQty(s.deliveries),
            consumed: fmtQty(s.consumption),
            ending: fmtQty(s.endingStock),
          };
          for (const c of sumCols) {
            doc.text(String(vals[c.key] ?? ''), sx + 4, y + 4, { width: c.w - 8, align: c.align || 'left', lineBreak: false });
            sx += c.w;
          }
          doc.moveTo(M, y + sumRowH).lineTo(W - M, y + sumRowH).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
          y += sumRowH;
        }
        y += 16;
      }

      // ── Delivery matrix — grouped into one section per material (the
      // caller already sorts lines by Material then ExpiryDate), each with
      // its own header band and a subtotal row, mirroring the Summary tab
      // of the old per-vendor workbooks. ───────────────────────────────────
      const cols = [
        { key: 'invoice', label: 'Invoice / Ref', w: 150 },
        { key: 'matdoc',  label: 'GR Doc', w: 110 },
        { key: 'expiry',  label: 'Expiry', w: 90 },
        { key: 'qty',     label: 'Qty Declared', w: CW - (150 + 110 + 90), align: 'right' },
      ];

      const rowH = 20;
      const ensureSpace = (needed) => {
        if (y + needed > doc.page.height - 100) {
          doc.addPage();
          y = M;
          return true;
        }
        return false;
      };
      const drawTableHeader = () => {
        doc.rect(M, y, CW, rowH).fill('#f3f4f6');
        let x = M;
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#374151');
        for (const c of cols) {
          doc.text(c.label.toUpperCase(), x + 4, y + 6, { width: c.w - 8, align: c.align || 'left', lineBreak: false });
          x += c.w;
        }
        y += rowH;
      };
      const drawSectionBand = (material) => {
        doc.rect(M, y, CW, rowH).fill('#0d4c45');
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff')
           .text(material || '(no material)', M + 4, y + 5, { width: CW - 8, lineBreak: false });
        y += rowH;
      };

      // Group consecutive lines by material — caller's sort order preserved.
      const groups = [];
      for (const line of (data.lines || [])) {
        const last = groups[groups.length - 1];
        if (last && last.material === (line.material || '')) last.lines.push(line);
        else groups.push({ material: line.material || '', lines: [line] });
      }

      for (const group of groups) {
        ensureSpace(rowH * 3);
        drawSectionBand(group.material);
        drawTableHeader();

        let subtotal = 0;
        let uom = '';
        for (const line of group.lines) {
          if (ensureSpace(rowH)) drawTableHeader();
          let x = M;
          doc.font('Helvetica').fontSize(8.5).fillColor('#111827');
          const values = {
            invoice: line.invoiceNumber || '—',
            matdoc:  line.materialDocument || '—',
            expiry:  line.expiryDate ? fmtDate(line.expiryDate) : '—',
            qty:     `${fmtQty(line.qtyAllocated)}${line.uom ? ' ' + line.uom : ''}`,
          };
          for (const c of cols) {
            doc.text(String(values[c.key] ?? ''), x + 4, y + 5, { width: c.w - 8, align: c.align || 'left', lineBreak: false });
            x += c.w;
          }
          doc.moveTo(M, y + rowH).lineTo(W - M, y + rowH).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
          y += rowH;
          subtotal += Number(line.qtyAllocated) || 0;
          uom = uom || line.uom || '';
        }

        ensureSpace(rowH);
        doc.rect(M, y, CW, rowH).fill('#f9fafb');
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#111827')
           .text(`Subtotal — ${group.material || '(no material)'}: ${fmtQty(subtotal)}${uom ? ' ' + uom : ''}`,
                 M + 4, y + 5, { width: CW - 8, align: 'right', lineBreak: false });
        y += rowH + 6;
      }

      // ── Total ────────────────────────────────────────────────────────────
      y += 10;
      ensureSpace(20);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827')
         .text(`Total Declared: ${fmtQty(data.totalQty)}`, M, y, { width: CW, align: 'right', lineBreak: false });

      // ── Footer ───────────────────────────────────────────────────────────
      // Drawn on every buffered page, well clear of the bottom margin — see
      // lib/poPdf.js's own footer comment for why: a footer sitting only a
      // few points off the margin boundary (the previous `height - 50` here)
      // is enough for pdfkit's auto-pagination to silently push it onto a
      // fresh, otherwise blank page instead of the bottom of the last page
      // with actual content.
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const footerY = doc.page.height - 60;
        doc.moveTo(M, footerY).lineTo(W - M, footerY).strokeColor('#0d4c45').lineWidth(1).stroke();
        doc.font('Helvetica').fontSize(7).fillColor('#9ca3af')
           .text(`Generated ${fmtDate(new Date())} — ${KONGSBERG_NAME}`, M, footerY + 6, { width: CW, lineBreak: false });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
