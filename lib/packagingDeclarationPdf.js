// ── Packaging Declaration of Conformity PDF builder ─────────────────────────
//
// One-page, shipment-accompanying customs/compliance declaration (Regulation
// (EU) 2025/40 on packaging and packaging waste), reproducing the layout of
// the reference document
// "Kongsberg_One_Page_Packaging_Declaration_Customs.docx" in code rather
// than templating the actual .docx — this repo has no docx-templating or
// docx->PDF conversion tooling, and the production host isn't confirmed to
// have LibreOffice/Word installed for that conversion. Same pdfkit
// convention as lib/poPdf.js / lib/consignmentDeclarationPdf.js (the only
// other "real document" PDF builders in this repo) — header band, manual
// x/y label+value layout, no table/grid library.
//
// Unlike those two, this document has no variable-length line items — the
// reference docx is explicitly a single page — so no page-break machinery
// is needed for the normal case; ensureSpace()/the buffered-page footer
// loop are still included as a safety net only (e.g. an unusually long
// customer name wrapping further than expected).
import PDFDocument from 'pdfkit';

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return `${fmtDate(dt)} ${dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

const KONGSBERG_NAME = 'Kongsberg Actuation System Ltd';
const KONGSBERG_ISSUER = 'Kongsberg Actuation Systems Ltd t/a Kongsberg Automotive';
const KONGSBERG_ADDRESS = 'Unit C, Euroflex Centre, Foxbridge Way, Normanton, West Yorkshire, WF6 1TN, UK';
const KONGSBERG_REGISTRATION = 'England No. 06444481';
const KONGSBERG_CONTACT = '+44 1924 228 000';

const DECLARATION_TEXT = 'We declare under our sole responsibility that the packaging identified above and '
  + 'supplied with this delivery is intended for the containment, protection, handling and transport of '
  + 'industrial goods and complies with the applicable requirements of Regulation (EU) 2025/40 on packaging '
  + 'and packaging waste, on the basis of the relevant packaging specifications and supporting supplier '
  + 'documentation retained by the company.';

const RESTRICTED_SUBSTANCES_TEXT = 'The presence and concentration of substances of concern are minimised. '
  + 'The sum of lead, cadmium, mercury and hexavalent chromium in the packaging or its components does not '
  + 'exceed 100 mg/kg, except where a lawful exemption applies. The packaging is not intended for food '
  + 'contact. Any material, coating, ink, adhesive, treatment or supplier change is subject to reassessment.';

const LEGAL_FOOTER_TEXT = 'Legal reference: Regulation (EU) 2025/40 of 19 December 2024 on packaging and '
  + 'packaging waste, OJ L 2025/40, 22 January 2025. This declaration accompanies the shipment and does not '
  + 'replace the supporting technical documentation.';

const PACKAGING_ITEMS = [
  { key: 'woodenPallets', label: 'Wooden pallets', caption: 'Solid wood' },
  { key: 'woodenSpools', label: 'Wooden spools', caption: 'Solid wood' },
  { key: 'cardboardBoxes', label: 'Cardboard boxes', caption: 'Corrugated fibreboard' },
  { key: 'bubblewrapSheets', label: 'Bubblewrap sheets', caption: 'Flexible plastic cushioning' },
];

const WOOD_STATEMENTS = [
  {
    text: 'Where wooden pallets or wooden spools are used, applicable ISPM 15 treatment and marking '
      + 'requirements have been met.',
    render: (doc, x, y, data) => drawYesNa(doc, x, y, data.ispm15 === 'yes'),
  },
  {
    text: 'No straw, hay, peat, chaff or used fruit/vegetable cartons have been used as packaging or dunnage.',
    render: (doc, x, y, data) => drawCheckboxLabel(doc, x, y, !!data.dunnageConfirmed, 'Confirmed'),
  },
  {
    text: 'For containerised shipments, the container is clean and free from visible animal/plant material '
      + 'and soil.',
    render: (doc, x, y, data) => drawYesNa(doc, x, y, data.containerClean === 'yes'),
  },
];

function drawCheckbox(doc, x, y, checked, size = 9) {
  doc.lineWidth(1).rect(x, y, size, size).stroke('#0d4c45');
  if (!checked) return;
  doc.rect(x + 1.5, y + 1.5, size - 3, size - 3).fill('#0d4c45');
  doc.lineWidth(1.2).strokeColor('#ffffff')
     .moveTo(x + size * 0.18, y + size * 0.55)
     .lineTo(x + size * 0.4, y + size * 0.78)
     .lineTo(x + size * 0.84, y + size * 0.2)
     .stroke();
}

function drawCheckboxLabel(doc, x, y, checked, label, opts = {}) {
  const size = opts.size || 9;
  drawCheckbox(doc, x, y, checked, size);
  doc.font(opts.font || 'Helvetica-Bold').fontSize(opts.fontSize || 9).fillColor(opts.color || '#003B5C')
     .text(label, x + size + 5, y - 1, { lineBreak: false });
}

function drawYesNa(doc, x, y, isYes) {
  drawCheckboxLabel(doc, x, y, isYes, 'Yes');
  drawCheckboxLabel(doc, x + 60, y, !isYes, 'N/A');
}

function sectionLabel(doc, text, x, y, width) {
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#0d4c45')
     .text(text, x, y, { width, lineBreak: false });
}

/**
 * @param {object} data
 * @param {string} data.shipmentRef
 * @param {string} [data.deliveryRef]
 * @param {string} [data.customerName]
 * @param {string|Date} [data.dispatchDate]
 * @param {object} data.packaging  { woodenPallets, woodenSpools, cardboardBoxes, bubblewrapSheets } — booleans
 * @param {'yes'|'na'} data.ispm15
 * @param {boolean} data.dunnageConfirmed
 * @param {'yes'|'na'} data.containerClean
 * @param {string} data.signedByName
 * @param {string} data.signedByPosition
 * @param {string|Date} data.signedAt
 * @returns {Promise<Buffer>}
 */
export async function buildPackagingDeclarationPdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4', layout: 'portrait', margin: 40,
        info: { Title: `Packaging Declaration ${data.shipmentRef}`, Author: 'Kongsberg Automotive' },
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
      doc.font('Helvetica-Bold').fontSize(15).fillColor('#ffffff')
         .text('KONGSBERG AUTOMOTIVE', M, 16, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(15).fillColor('#ffffff')
         .text('PACKAGING DECLARATION OF CONFORMITY', M, 16, { width: CW, align: 'right', lineBreak: false });
      doc.font('Helvetica').fontSize(8).fillColor('rgba(255,255,255,0.8)')
         .text('Shipment-accompanying declaration for EU customs and customer clearance',
               M, 36, { width: CW, align: 'right', lineBreak: false });

      let y = 78;
      const ensureSpace = (needed) => {
        if (y + needed > doc.page.height - 90) {
          doc.addPage();
          y = M;
          return true;
        }
        return false;
      };
      const colW = CW / 2 - 10;
      const col2X = M + colW + 20;
      const headerRows = [
        ['Issuer', KONGSBERG_ISSUER, 'Delivery / invoice no.', data.deliveryRef || '—'],
        ['Address', KONGSBERG_ADDRESS, 'Consignment / shipment no.', data.shipmentRef || '—'],
        ['Registration', KONGSBERG_REGISTRATION, 'Customer / consignee', data.customerName || '—'],
        ['Contact', KONGSBERG_CONTACT, 'Date of dispatch', fmtDate(data.dispatchDate)],
      ];
      for (const [label1, value1, label2, value2] of headerRows) {
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280').text(label1.toUpperCase(), M, y, { lineBreak: false });
        doc.font('Helvetica').fontSize(9.5).fillColor('#111827').text(value1, M, y + 11, { width: colW, lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280').text(label2.toUpperCase(), col2X, y, { lineBreak: false });
        doc.font('Helvetica').fontSize(9.5).fillColor('#111827').text(value2, col2X, y + 11, { width: colW, lineBreak: false });
        y += 28;
      }

      y += 6;
      doc.moveTo(M, y).lineTo(W - M, y).strokeColor('#0d4c45').lineWidth(1).stroke();
      y += 14;

      // ── Packaging included in this delivery — the 4 confirmable packaging
      // materials, ticked from what the operator confirmed on-screen. ──────
      sectionLabel(doc, 'PACKAGING INCLUDED IN THIS DELIVERY', M, y, CW);
      y += 16;
      const pCol = CW / 4;
      doc.rect(M, y, CW, 26).fill('#003B5C');
      for (let i = 0; i < PACKAGING_ITEMS.length; i++) {
        const item = PACKAGING_ITEMS[i];
        const x = M + i * pCol + 8;
        drawCheckbox(doc, x, y + 9, !!data.packaging?.[item.key]);
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff')
           .text(item.label, x + 13, y + 8, { width: pCol - 24, lineBreak: false });
      }
      y += 26;
      doc.rect(M, y, CW, 18).fill('#f5f7f8');
      for (let i = 0; i < PACKAGING_ITEMS.length; i++) {
        const item = PACKAGING_ITEMS[i];
        const x = M + i * pCol;
        doc.font('Helvetica').fontSize(7.5).fillColor('#6b7280')
           .text(item.caption, x, y + 5, { width: pCol, align: 'center', lineBreak: false });
      }
      y += 18 + 14;

      // ── Declaration — fixed legal text, no fields. ────────────────────────
      ensureSpace(70);
      sectionLabel(doc, 'DECLARATION', M, y, CW);
      y += 14;
      {
        const textH = doc.font('Helvetica').fontSize(9).heightOfString(DECLARATION_TEXT, { width: CW - 20 });
        const boxH = textH + 16;
        doc.rect(M, y, CW, boxH).fill('#EAF4F8');
        doc.font('Helvetica').fontSize(9).fillColor('#111827')
           .text(DECLARATION_TEXT, M + 10, y + 8, { width: CW - 20 });
        y += boxH + 12;
      }

      // ── Restricted substances — fixed legal text, no fields. ─────────────
      ensureSpace(70);
      {
        const label = 'RESTRICTED SUBSTANCES: ';
        const fullTextH = doc.font('Helvetica').fontSize(9)
          .heightOfString(label + RESTRICTED_SUBSTANCES_TEXT, { width: CW - 20 });
        const boxH = fullTextH + 16;
        doc.rect(M, y, CW, boxH).fill('#f5f7f8');
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#003B5C')
           .text(label, M + 10, y + 8, { continued: true, width: CW - 20 });
        doc.font('Helvetica').fillColor('#111827').text(RESTRICTED_SUBSTANCES_TEXT);
        y += boxH + 14;
      }

      // ── Wood packaging and shipment statements — the remaining 3
      // confirmable tickbox groups (ISPM 15 / dunnage / container). ────────
      ensureSpace(110);
      sectionLabel(doc, 'WOOD PACKAGING AND SHIPMENT STATEMENTS', M, y, CW);
      y += 16;
      const stmtValueW = 150;
      const stmtTextW = CW - stmtValueW - 12;
      for (let i = 0; i < WOOD_STATEMENTS.length; i++) {
        const stmt = WOOD_STATEMENTS[i];
        const rowH = Math.max(28, doc.font('Helvetica').fontSize(8.5).heightOfString(stmt.text, { width: stmtTextW - 16 }) + 14);
        doc.rect(M, y, CW, rowH).fill(i % 2 === 0 ? '#f5f7f8' : '#ffffff');
        doc.font('Helvetica').fontSize(8.5).fillColor('#111827')
           .text(stmt.text, M + 8, y + 7, { width: stmtTextW - 16 });
        stmt.render(doc, M + stmtTextW + 8, y + 7, data);
        doc.moveTo(M, y + rowH).lineTo(W - M, y + rowH).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
        y += rowH;
      }
      y += 14;

      // ── Authorised signature for this delivery — the "digital signature":
      // logged-in user's display name + the position they typed in at
      // confirm-time + a generation timestamp, printed as an electronic
      // attestation rather than a scanned/cryptographic signature. ─────────
      ensureSpace(70);
      sectionLabel(doc, 'AUTHORISED SIGNATURE FOR THIS DELIVERY', M, y, CW);
      y += 16;
      const sigColW = CW / 2 - 10;
      const sigRows = [
        ['Name', data.signedByName || '—', 'Position', data.signedByPosition || '—'],
        ['Signature', `Electronically signed by ${data.signedByName || '—'}`, 'Issue date', fmtDateTime(data.signedAt)],
      ];
      for (const [label1, value1, label2, value2] of sigRows) {
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280').text(label1.toUpperCase(), M, y, { lineBreak: false });
        doc.font(label1 === 'Signature' ? 'Helvetica-Oblique' : 'Helvetica').fontSize(9.5).fillColor('#111827')
           .text(value1, M, y + 11, { width: sigColW, lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280').text(label2.toUpperCase(), col2X, y, { lineBreak: false });
        doc.font('Helvetica').fontSize(9.5).fillColor('#111827').text(value2, col2X, y + 11, { width: sigColW, lineBreak: false });
        y += 28;
      }

      // ── Legal reference — the docx's own final paragraph, part of the
      // page body (not a running footer) so its wrapped height is
      // accounted for by ensureSpace like everything else above. ──────────
      {
        const textH = doc.font('Helvetica').fontSize(7).heightOfString(LEGAL_FOOTER_TEXT, { width: CW });
        ensureSpace(textH + 10);
        doc.font('Helvetica').fontSize(7).fillColor('#6b7280')
           .text(LEGAL_FOOTER_TEXT, M, y, { width: CW });
      }

      // ── Running footer — drawn on every buffered page, well clear of the
      // bottom margin and kept to a single short line (see
      // lib/poPdf.js's own footer comment: a footer only a few points off
      // the margin — or tall enough to wrap — is enough for pdfkit's
      // auto-pagination to silently push it onto a fresh, otherwise blank
      // page; that's why the legal text above is body content, not this). ──
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const footerY = doc.page.height - 60;
        doc.moveTo(M, footerY).lineTo(W - M, footerY).strokeColor('#0d4c45').lineWidth(1).stroke();
        doc.font('Helvetica').fontSize(7).fillColor('#9ca3af')
           .text(`Generated ${fmtDateTime(new Date())} — ${KONGSBERG_NAME}`, M, footerY + 6, { width: CW, lineBreak: false });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
