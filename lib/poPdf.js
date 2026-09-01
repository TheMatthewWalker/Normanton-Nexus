// ── Purchase Order PDF builder ──────────────────────────────────────────────
//
// Generates a real, sendable Purchase Order document from a just-created SAP
// PO (see routes/performance.js POST /order-suggestions/create-po, and the
// standalone POST /order-suggestions/regenerate-pdf for re-creating one
// later from Tracked Orders). Uses pdfkit, matching the existing convention
// in routes/labels.js's production label builder — the only other
// PDF-building code in this repo (there's also a hand-rolled raw-PDF-byte
// writer in routes/shipmentmain.js, but that predates pdfkit being a
// dependency and isn't worth replicating for new work).
//
// Layout/wording (T&Cs text, "Terms of delivery" framing) matches the real
// SAP-issued POs this replaces — see a live example the user pointed to
// (J:\Common\Logistics\Re-Ordering\Purchase Orders\HiFi\4500434951.pdf) —
// rather than being invented from scratch.
//
// KNOWN GAP: dbo.Vendor has no address columns (street/city/postcode/
// country) and there's no SAP vendor-address lookup wired into this repo, so
// the vendor block below only has a name + SAP vendor number — no postal
// address. Add address fields to dbo.Vendor (+ Vendor Master Data UI) if a
// full address is needed later; this document was shipped without one on
// purpose rather than block the feature on that separate piece of work.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.join(__dirname, '..', 'public', 'images', 'logo256.png');

// Matches the Nexus portal's own primary brand colour (public/css/index.css
// --accent/--accent2) — not the per-module accent colours (e.g. logistics.css's
// teal), since this document represents the whole company, not one module.
const BRAND_BLUE = '#2563EB';
const INK        = '#111827';
const INK_DIM     = '#6b7280';
const RULE        = '#e5e7eb';

// Kongsberg's own origin address — hardcoded the same way
// routes/shipmentmain.js's getLogisticsSettings() hardcodes it for the
// outbound shipment documents (no per-environment config for this, it's
// the one physical site this app runs at). VAT number is the same one
// already printed on every real Kongsberg PO (see the reference PDF above).
const KONGSBERG_NAME    = 'Kongsberg Actuation System Ltd';
const KONGSBERG_STREET  = 'Euroflex Centre, Foxbridge Way';
const KONGSBERG_CITY    = 'Normanton';
const KONGSBERG_POSTCODE = 'WF6 1TN';
const KONGSBERG_COUNTRY = 'United Kingdom';
const KONGSBERG_VAT     = 'GB214987833';

// Standard Kongsberg Automotive purchasing terms & conditions text, copied
// verbatim from a real SAP-issued PO (see this file's header comment) rather
// than paraphrased, since this is binding wording.
const TERMS_AND_CONDITIONS = 'This Purchase Order is subject to Kongsberg Automotive General Purchasing '
  + 'Conditions and any amendments, addenda or modifications thereto (collectively the "Purchase Terms"), '
  + 'the Supplier Quality Manual and Supplier Declaration, as in effect on the date of this Purchase Order. '
  + 'The Purchase Terms, Supplier Quality Manual and Supplier Declaration are available at '
  + 'www.kongsbergautomotive.com/for_suppliers/';

// Standard supplier certification/labelling notice, printed under the T&Cs
// on every PO — wording supplied verbatim by the user (see routes/
// performance.js's create-po/regenerate-pdf), not paraphrased, since it's
// the same kind of binding/compliance text as TERMS_AND_CONDITIONS above.
const SUPPLIER_NOTICE = 'Please note that your company is required to be certified against the latest '
  + 'version of ISO 9001, with the target of achieving IATF 16949, as well as ISO 14001 or EMAS.\n\n'
  + 'Supplier, order and part numbers, must always be stated on order acknowledgements, invoices, '
  + 'packing notes and goods labels.';

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
 * @param {string} [data.incoterms]
 * @param {string} [data.purchaserName] - Signs off the supplier notice block under the T&Cs (falls back to a blank signature line when unknown, e.g. a system-triggered regenerate with no acting user).
 * @param {Array<{poItemNumber:string, material:string, materialText?:string, quantity:number, uom:string, deliveryDate?:string|Date, isExw?:boolean, netPrice?:number|null}>} data.items
 * @returns {Promise<Buffer>}
 */
export async function buildPoPdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4', layout: 'portrait', margin: 40,
        info: { Title: `Purchase Order ${data.poNumber}`, Author: 'Kongsberg Automotive' },
        bufferPages: true,
      });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width;
      const M = 40;
      const CW = W - 2 * M;

      // ── Header ───────────────────────────────────────────────────────────
      // White background with a blue accent (matches the Nexus portal's own
      // brand colour, not a solid colour band) and the real Kongsberg mark,
      // rather than the previous dark solid band — puts the (blue) logo on
      // a background it's actually visible against.
      let logoDrawn = false;
      try {
        if (fs.existsSync(LOGO_PATH)) {
          doc.image(LOGO_PATH, W - M - 42, 28, { width: 42, height: 42 });
          logoDrawn = true;
        }
      } catch {
        // Missing/unreadable logo file must never break PO generation.
      }

      doc.font('Helvetica-Bold').fontSize(22).fillColor(INK)
         .text('Purchase Order', M, 32, { continued: true, lineBreak: false });
      doc.font('Helvetica').fontSize(22).fillColor(BRAND_BLUE)
         .text(` ${data.poNumber}`, { lineBreak: false });

      let y = 78;
      doc.moveTo(M, y).lineTo(logoDrawn ? W - M - 54 : W - M, y).strokeColor(BRAND_BLUE).lineWidth(2).stroke();
      y += 18;

      // ── Vendor / Ordered By / PO meta — three columns ───────────────────
      // The middle column is given extra room (up to just short of column
      // 3) rather than an equal third — "Kongsberg Actuation System Ltd" at
      // a readable size wrapped onto a second line in the old equal-thirds
      // layout.
      const col1X = M;
      const col2X = M + 165;
      const col3X = M + 345;
      const col2W = col3X - col2X - 12;
      const col3W = W - M - col3X;

      doc.font('Helvetica-Bold').fontSize(8).fillColor(INK_DIM)
         .text('SUPPLIER', col1X, y, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(11);
      // Vendor names are free text with no length limit in Vendor Master
      // Data, unlike KONGSBERG_NAME's fixed, known-short string below — the
      // SAP Vendor line underneath has to shift down by however many lines
      // the name actually wrapped to, or a long name overlaps it.
      const vendorNameHeight = doc.heightOfString(data.vendorName || '—', { width: 155 });
      doc.fillColor(INK).text(data.vendorName || '—', col1X, y + 12, { width: 155 });
      if (data.sapVendorNumber) {
        doc.font('Helvetica').fontSize(9).fillColor(INK_DIM)
           .text(`SAP Vendor ${data.sapVendorNumber}`, col1X, y + 12 + vendorNameHeight + 2, { width: 155, lineBreak: false });
      }

      doc.font('Helvetica-Bold').fontSize(8).fillColor(INK_DIM)
         .text('ORDERED BY', col2X, y, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK)
         .text(KONGSBERG_NAME, col2X, y + 12, { width: col2W, lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor(INK_DIM)
         .text(`${KONGSBERG_STREET}\n${KONGSBERG_CITY}, ${KONGSBERG_POSTCODE}\n${KONGSBERG_COUNTRY}`,
               col2X, y + 26, { width: col2W });

      doc.font('Helvetica-Bold').fontSize(8).fillColor(INK_DIM)
         .text('DATE', col3X, y, { lineBreak: false });
      doc.font('Helvetica').fontSize(10).fillColor(INK)
         .text(fmtDate(data.poDate), col3X, y + 12, { width: col3W, lineBreak: false });
      let metaY = y + 32;
      if (data.currency) {
        doc.font('Helvetica-Bold').fontSize(8).fillColor(INK_DIM)
           .text('CURRENCY', col3X, metaY, { lineBreak: false });
        doc.font('Helvetica').fontSize(10).fillColor(INK)
           .text(data.currency, col3X, metaY + 12, { width: col3W, lineBreak: false });
        metaY += 32;
      }
      if (data.incoterms) {
        doc.font('Helvetica-Bold').fontSize(8).fillColor(INK_DIM)
           .text('INCOTERMS', col3X, metaY, { lineBreak: false });
        doc.font('Helvetica').fontSize(10).fillColor(INK)
           .text(data.incoterms, col3X, metaY + 12, { width: col3W, lineBreak: false });
      }

      y += 92;
      doc.moveTo(M, y).lineTo(W - M, y).strokeColor(RULE).lineWidth(1).stroke();
      y += 16;

      // ── Line items table ─────────────────────────────────────────────────
      // EXW items are collected from their VENDOR's own site, not delivered
      // to Kongsberg — the date on the PO for those lines is when the goods
      // must be ready for collection (ReadyToCollectDate), not a delivery
      // date, so the column itself relabels rather than just reusing
      // "Delivery Date" with a different meaning underneath. The caller
      // (routes/performance.js) is responsible for putting the right
      // underlying date into item.deliveryDate — this only decides the
      // column's own label, and only when EVERY item on the PO is EXW
      // (matches reality: one PO is always one vendor / one incoterm).
      const allExw = (data.items || []).length > 0 && (data.items || []).every(it => it.isExw);
      const deliveryLabel = allExw ? 'Ex Works Date' : 'Delivery Date';

      // delivery is wide enough for "EX WORKS DATE"/"DELIVERY DATE" in bold
      // 8pt caps on one line — narrower than that wrapped the header label
      // onto two lines within the fixed-height header row.
      const hasPrice = (data.items || []).some(it => it.netPrice !== null && it.netPrice !== undefined && it.netPrice !== '');
      const cols = hasPrice
        ? [ { key: 'item', label: 'Item', w: 34 }, { key: 'material', label: 'Material', w: 80 },
            { key: 'desc', label: 'Description', w: 110 }, { key: 'qty', label: 'Qty', w: 55, align: 'right' },
            { key: 'uom', label: 'UOM', w: 34 }, { key: 'delivery', label: deliveryLabel, w: 88 },
            { key: 'price', label: 'Price', w: CW - (34 + 80 + 110 + 55 + 34 + 88), align: 'right' } ]
        : [ { key: 'item', label: 'Item', w: 40 }, { key: 'material', label: 'Material', w: 105 },
            { key: 'desc', label: 'Description', w: 165 }, { key: 'qty', label: 'Qty', w: 75, align: 'right' },
            { key: 'uom', label: 'UOM', w: 42 }, { key: 'delivery', label: deliveryLabel, w: CW - (40 + 105 + 165 + 75 + 42) } ];

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

      let priceTotal = 0;
      let allPriced = (data.items || []).length > 0;
      doc.font('Helvetica').fontSize(8.5);
      for (const it of (data.items || [])) {
        const hasLinePrice = it.netPrice !== null && it.netPrice !== undefined && it.netPrice !== '';
        if (hasLinePrice) priceTotal += Number(it.quantity || 0) * Number(it.netPrice);
        else allPriced = false;
        const values = {
          item: it.poItemNumber || '',
          material: it.material || '',
          desc: it.materialText || '',
          qty: fmtQty(it.quantity),
          uom: it.uom || '',
          delivery: fmtDate(it.deliveryDate),
          price: fmtPrice(it.netPrice, data.currency) || 'Per SAP condition',
        };

        // Row height grows to fit whichever cell wraps tallest (almost
        // always Description on a long materialText) instead of a fixed
        // rowH — pdfkit wraps any cell whose text exceeds its column width
        // regardless of the lineBreak option, so a fixed row height let a
        // wrapped second/third line poke through the grey separator drawn
        // at the old fixed offset.
        let cellHeight = rowH;
        for (const c of cols) {
          const h = doc.heightOfString(String(values[c.key] ?? ''), { width: c.w - 8 }) + 10;
          if (h > cellHeight) cellHeight = h;
        }

        if (y + cellHeight > doc.page.height - 140) {
          doc.addPage();
          y = M;
          drawTableHeader();
        }

        let x = M;
        doc.fillColor(INK);
        for (const c of cols) {
          doc.text(String(values[c.key] ?? ''), x + 4, y + 5, { width: c.w - 8, align: c.align || 'left' });
          x += c.w;
        }
        doc.moveTo(M, y + cellHeight).lineTo(W - M, y + cellHeight).strokeColor(RULE).lineWidth(0.5).stroke();
        y += cellHeight;
      }

      if (hasPrice && allPriced) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
           .text('Total', M, y + 6, { width: CW - cols[cols.length - 1].w - 8, align: 'right', lineBreak: false });
        doc.text(fmtPrice(priceTotal, data.currency) || '', W - M - cols[cols.length - 1].w + 4, y + 6,
                 { width: cols[cols.length - 1].w - 8, align: 'right', lineBreak: false });
        y += rowH;
      }

      y += 14;
      if (!hasPrice) {
        doc.font('Helvetica-Oblique').fontSize(8).fillColor(INK_DIM)
           .text('Pricing determined by SAP purchasing info record / condition records at time of order — not shown on this document.', M, y, { width: CW });
        y += 24;
      }

      // ── Terms & Conditions ───────────────────────────────────────────────
      if (y + 60 > doc.page.height - 100) { doc.addPage(); y = M; }
      doc.rect(M, y, CW, 2).fill(BRAND_BLUE);
      y += 8;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(INK)
         .text('TERMS & CONDITIONS', M, y, { lineBreak: false });
      y += 12;
      doc.font('Helvetica').fontSize(7.5).fillColor(INK_DIM);
      const termsHeight = doc.heightOfString(TERMS_AND_CONDITIONS, { width: CW, lineGap: 1 });
      doc.text(TERMS_AND_CONDITIONS, M, y, { width: CW, lineGap: 1 });
      y += termsHeight;

      // Closing rule, mirroring the one that opens the T&Cs block above.
      y += 8;
      doc.rect(M, y, CW, 2).fill(BRAND_BLUE);
      y += 8;

      // ── Supplier notice + sign-off ──────────────────────────────────────
      // Same page-break guard as the T&Cs block above — this whole block
      // (notice text + signature) is short enough to always treat as one
      // unbreakable unit rather than working out where pdfkit would wrap it.
      if (y + 110 > doc.page.height - 60) { doc.addPage(); y = M; }
      doc.font('Helvetica').fontSize(8).fillColor(INK);
      const noticeHeight = doc.heightOfString(SUPPLIER_NOTICE, { width: CW, lineGap: 2 });
      doc.text(SUPPLIER_NOTICE, M, y, { width: CW, lineGap: 2 });
      y += noticeHeight + 16;

      doc.font('Helvetica').fontSize(8).fillColor(INK)
         .text('With regards', M, y, { width: CW, lineBreak: false });
      y += 12;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
         .text(KONGSBERG_NAME, M, y, { width: CW, lineBreak: false });
      y += 32;
      doc.font('Helvetica').fontSize(8).fillColor(INK)
         .text(data.purchaserName || '—', M, y, { width: CW, lineBreak: false });
      y += 11;
      doc.font('Helvetica').fontSize(7.5).fillColor(INK_DIM)
         .text('Purchaser', M, y, { width: CW, lineBreak: false });

      // ── Footer ───────────────────────────────────────────────────────────
      // Drawn on every page pdfkit ended up producing (bufferPages lets the
      // page count be known up front), not just whichever page happened to
      // be current when this ran. A SINGLE line, well clear of the bottom
      // margin — the previous two-line version (footerY = page.height - 50)
      // had its second line land within a few points of the margin
      // boundary, which is enough for pdfkit's own auto-pagination to kick
      // in and silently push that line onto a fresh, otherwise blank page
      // instead of clipping or shrinking it.
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const footerY = doc.page.height - 60;
        doc.moveTo(M, footerY).lineTo(W - M, footerY).strokeColor(RULE).lineWidth(1).stroke();
        doc.font('Helvetica').fontSize(7).fillColor(INK_DIM)
           .text(
             `${KONGSBERG_NAME} · ${KONGSBERG_STREET}, ${KONGSBERG_CITY} ${KONGSBERG_POSTCODE} · VAT ${KONGSBERG_VAT} · `
             + `Generated ${fmtDate(new Date())} · Page ${i - range.start + 1} of ${range.count}`,
             M, footerY + 8, { width: CW, lineBreak: false });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
