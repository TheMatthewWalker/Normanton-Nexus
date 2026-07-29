// ── Purchase Order PDF builder ──────────────────────────────────────────────
//
// Generates a real, sendable Purchase Order document from a just-created SAP
// PO (see routes/performance.js POST /order-suggestions/create-po). Uses
// pdfkit, matching the existing convention in routes/labels.js's production
// label builder — the only other PDF-building code in this repo (there's
// also a hand-rolled raw-PDF-byte writer in routes/shipmentmain.js, but that
// predates pdfkit being a dependency and isn't worth replicating for new
// work).
//
// KNOWN GAP: dbo.Vendor has no address columns (street/city/postcode/
// country) and there's no SAP vendor-address lookup wired into this repo, so
// the vendor block below only has a name + SAP vendor number — no postal
// address. Add address fields to dbo.Vendor (+ Vendor Master Data UI) if a
// full address is needed later; this document was shipped without one on
// purpose rather than block the feature on that separate piece of work.
import PDFDocument from 'pdfkit';

// Kongsberg's own origin address — hardcoded the same way
// routes/shipmentmain.js's getLogisticsSettings() hardcodes it for the
// outbound shipment documents (no per-environment config for this, it's
// the one physical site this app runs at).
const KONGSBERG_NAME    = 'Kongsberg Actuation System Ltd';
const KONGSBERG_STREET  = 'Euroflex Centre, Foxbridge Way';
const KONGSBERG_CITY    = 'Normanton';
const KONGSBERG_POSTCODE = 'WF6 1TN';
const KONGSBERG_COUNTRY = 'United Kingdom';

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

function fmtPrice(n, currency) {
  if (n === null || n === undefined || n === '') return null;
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  return `${currency || ''} ${num.toFixed(2)}`.trim();
}

/**
 * @param {object} data
 * @param {string} data.poNumber
 * @param {string|Date} data.poDate
 * @param {string} data.vendorName
 * @param {string} [data.sapVendorNumber]
 * @param {string} [data.currency]
 * @param {Array<{poItemNumber:string, material:string, materialText?:string, quantity:number, uom:string, deliveryDate?:string|Date, netPrice?:number|null}>} data.items
 * @returns {Promise<Buffer>}
 */
export async function buildPoPdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4', layout: 'portrait', margin: 40,
        info: { Title: `Purchase Order ${data.poNumber}`, Author: 'Kongsberg Automotive' },
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
      doc.font('Helvetica-Bold').fontSize(20).fillColor('#ffffff')
         .text('PURCHASE ORDER', M, 0, { width: CW, align: 'right', lineBreak: false });
      doc.font('Helvetica').fontSize(10).fillColor('rgba(255,255,255,0.8)')
         .text(`PO ${data.poNumber}`, M, 24, { width: CW, align: 'right', lineBreak: false });

      let y = 80;

      // ── Vendor / From / PO meta — three columns ─────────────────────────
      const colW = CW / 3 - 8;
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280')
         .text('SUPPLIER', M, y, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827')
         .text(data.vendorName || '—', M, y + 12, { width: colW, lineBreak: true });
      if (data.sapVendorNumber) {
        doc.font('Helvetica').fontSize(9).fillColor('#6b7280')
           .text(`SAP Vendor ${data.sapVendorNumber}`, M, y + 30, { width: colW, lineBreak: false });
      }

      const col2X = M + colW + 12;
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280')
         .text('ORDERED BY', col2X, y, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827')
         .text(KONGSBERG_NAME, col2X, y + 12, { width: colW, lineBreak: true });
      doc.font('Helvetica').fontSize(9).fillColor('#6b7280')
         .text(`${KONGSBERG_STREET}\n${KONGSBERG_CITY}, ${KONGSBERG_POSTCODE}\n${KONGSBERG_COUNTRY}`,
               col2X, y + 30, { width: colW });

      const col3X = M + 2 * colW + 24;
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280')
         .text('PO NUMBER', col3X, y, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827')
         .text(data.poNumber, col3X, y + 12, { width: colW, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280')
         .text('DATE', col3X, y + 32, { lineBreak: false });
      doc.font('Helvetica').fontSize(10).fillColor('#111827')
         .text(fmtDate(data.poDate), col3X, y + 44, { width: colW, lineBreak: false });
      if (data.currency) {
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280')
           .text('CURRENCY', col3X, y + 62, { lineBreak: false });
        doc.font('Helvetica').fontSize(10).fillColor('#111827')
           .text(data.currency, col3X, y + 74, { width: colW, lineBreak: false });
      }

      y += 100;
      doc.moveTo(M, y).lineTo(W - M, y).strokeColor('#0d4c45').lineWidth(1.5).stroke();
      y += 16;

      // ── Line items table ─────────────────────────────────────────────────
      const hasPrice = (data.items || []).some(it => it.netPrice !== null && it.netPrice !== undefined && it.netPrice !== '');
      const cols = hasPrice
        ? [ { key: 'item', label: 'Item', w: 34 }, { key: 'material', label: 'Material', w: 90 },
            { key: 'desc', label: 'Description', w: 130 }, { key: 'qty', label: 'Qty', w: 60, align: 'right' },
            { key: 'uom', label: 'UOM', w: 34 }, { key: 'delivery', label: 'Delivery', w: 60 },
            { key: 'price', label: 'Price', w: CW - (34 + 90 + 130 + 60 + 34 + 60), align: 'right' } ]
        : [ { key: 'item', label: 'Item', w: 40 }, { key: 'material', label: 'Material', w: 110 },
            { key: 'desc', label: 'Description', w: 190 }, { key: 'qty', label: 'Qty', w: 80, align: 'right' },
            { key: 'uom', label: 'UOM', w: 50 }, { key: 'delivery', label: 'Delivery Date', w: CW - (40 + 110 + 190 + 80 + 50) } ];

      const rowH = 20;
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
      drawTableHeader();

      for (const it of (data.items || [])) {
        if (y + rowH > doc.page.height - 100) {
          doc.addPage();
          y = M;
          drawTableHeader();
        }
        let x = M;
        doc.font('Helvetica').fontSize(8.5).fillColor('#111827');
        const values = {
          item: it.poItemNumber || '',
          material: it.material || '',
          desc: it.materialText || '',
          qty: fmtQty(it.quantity),
          uom: it.uom || '',
          delivery: fmtDate(it.deliveryDate),
          price: fmtPrice(it.netPrice, data.currency) || 'Per SAP condition',
        };
        for (const c of cols) {
          doc.text(String(values[c.key] ?? ''), x + 4, y + 5, { width: c.w - 8, align: c.align || 'left', lineBreak: false });
          x += c.w;
        }
        doc.moveTo(M, y + rowH).lineTo(W - M, y + rowH).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
        y += rowH;
      }

      y += 16;
      if (!hasPrice) {
        doc.font('Helvetica-Oblique').fontSize(8).fillColor('#6b7280')
           .text('Pricing determined by SAP purchasing info record / condition records at time of order — not shown on this document.', M, y, { width: CW });
        y += 20;
      }

      // ── Footer ───────────────────────────────────────────────────────────
      const footerY = doc.page.height - 50;
      doc.moveTo(M, footerY).lineTo(W - M, footerY).strokeColor('#0d4c45').lineWidth(1).stroke();
      doc.font('Helvetica').fontSize(7).fillColor('#9ca3af')
         .text(`Generated ${fmtDate(new Date())} — ${KONGSBERG_NAME}`, M, footerY + 6, { width: CW, lineBreak: false });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
