import express from 'express';
import ExcelJS  from 'exceljs';
import axios    from 'axios';
import https    from 'https';
import fs       from 'fs';
import jwt      from 'jsonwebtoken';
import sql      from 'mssql';
import { sapConfig, sapServerSecret, sqlConfig } from '../config.js';
import { requirePermission } from '../middleware/auth.js';
import { lookupVatOverride, lookupHsDescription } from './customsreportadmin.js';

// ---------------------------------------------------------------------------
// routes/customsreport.js
//
// French VAT / DDP Customs Report (Logistics, permission LOG_CUSTOMS_REPORT).
// Recreates the monthly AT_Customs.xlsm workbook process: the user uploads a
// Shipments-style list (delivery/picksheet number, shipment ref, collection
// date, weight — the only data that isn't already in SAP), this route
// enriches every delivery line via SapServer's customs endpoints, apportions
// the manually-entered weight across delivery lines exactly like the
// workbook's SUMIFS/ROUND formula did, resolves VAT number / HS description
// fallbacks, and streams back a finished CUSTOMS-format .xlsx.
//
// Single POST /generate request, stateless — nothing from an upload is
// persisted. Partial/missing SAP data degrades a line to blank fields rather
// than aborting the whole run (this report is reviewed by a human before
// being sent on) — see the per-condition table in the implementation plan.
// The one case that IS a hard failure: zero delivery lines found in SAP at
// all, since there's nothing to build a report from.
//
// Calls SapServer's /api/customs/* endpoints DIRECTLY (own makeSapToken/
// sapAgent/audit boilerplate below, same as consignment.js/staging.js/
// productionnexus.js/deliverymain.js/quality.js — each SAP-calling route
// file in this repo owns its own rather than sharing one across files) —
// deliberately NOT via a loopback fetch to this app's own /api/sap/* proxy
// routes the way routes/shipmentmain.js's fetchSapCustomsData does. This app
// only ever listens on 443 (HTTPS) and 80 (redirect-only) — see server.js —
// there is no listener on process.env.PORT/3000, so a loopback call there
// fails to connect every time; the failure was getting swallowed by the
// per-round try/catch below and misreported as "no SAP data found".
// ---------------------------------------------------------------------------

const router = express.Router();

// ── SAP caller ────────────────────────────────────────────────────────────
const certPath = new URL('../certs/sap-server-cert.pem', import.meta.url);
const sapAgent = fs.existsSync(certPath)
  ? new https.Agent({ ca: fs.readFileSync(certPath), rejectUnauthorized: true })
  : null;

function makeSapToken() {
  return jwt.sign(
    { userId: 0 },
    sapServerSecret,
    { issuer: 'sql2005-bridge', audience: 'sap-server', expiresIn: '60s' }
  );
}

async function audit(eventType, username, detail, req) {
  try {
    const pool = await sql.connect(sqlConfig);
    const ip = req?.ip || req?.socket?.remoteAddress || null;
    await pool.request()
      .input('username',  sql.NVarChar(80),  username || null)
      .input('eventType', sql.NVarChar(50),  eventType)
      .input('detail',    sql.NVarChar(500), detail || null)
      .input('ip',        sql.NVarChar(45),  ip)
      .query(`INSERT INTO kongsberg.dbo.PortalAuditLog (Username, EventType, Detail, IPAddress)
              VALUES (@username, @eventType, @detail, @ip)`);
  } catch (err) {
    console.error('[customsreport audit]', err.message);
  }
}

function actor(req) {
  return req.session?.user?.username || 'unknown';
}

// POSTs directly to SapServer (mirrors routes/sap.js's own proxy calls) —
// returns the parsed array on success, or [] with a pushed warning on any
// failure (network error, non-2xx, or a body-level success:false). Never
// throws — callers decide what "nothing came back" means for that round.
async function sapPostArray(sapPath, body, label, warnings) {
  try {
    const response = await axios.post(
      `${sapConfig.url}${sapPath}`,
      body,
      { timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
    );
    const json = response.data;
    if (!json?.success) {
      warnings.push(`${label} query failed: ${json?.error?.message ?? json?.error ?? 'unknown error'}`);
      return [];
    }
    return Array.isArray(json.data) ? json.data : [];
  } catch (err) {
    const message = err.response?.data?.error?.message ?? err.response?.data?.error ?? err.message;
    warnings.push(`${label} query failed: ${message}`);
    return [];
  }
}

// ── Small helpers ─────────────────────────────────────────────────────────

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

function readCellNumber(row, colNumber) {
  if (!colNumber) return 0;
  const v = row.getCell(colNumber).value;
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && 'result' in v) return Number(v.result) || 0;
  return Number(v) || 0;
}

function readCellDate(row, colNumber) {
  if (!colNumber) return null;
  const v = row.getCell(colNumber).value;
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object' && v.result instanceof Date) return v.result;
  const s = String(v).trim();
  if (!s) return null;
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Strips SAP's zero-padding from a purely-numeric ID string (delivery
// number, item number, invoice number, consignee/customer code) so the
// report reads the same way the old workbook's macro output did
// ("82892007", not "0082892007") and so IDs from different SAP tables
// (differently padded on the way out of RFC_READ_TABLE) can be matched
// against each other and against the uploaded upload's own unpadded values.
export function digits(v) {
  const s = String(v ?? '').trim();
  if (!s || !/^\d+$/.test(s)) return s;
  const stripped = s.replace(/^0+(?=\d)/, '');
  return stripped;
}

// SAP internal date format (YYYYMMDD) → JS Date, or null.
export function parseSapDate(s) {
  const str = String(s ?? '').trim();
  if (!/^\d{8}$/.test(str)) return null;
  const year = Number(str.slice(0, 4));
  const month = Number(str.slice(4, 6));
  const day = Number(str.slice(6, 8));
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

// ── 1. Parse the uploaded Shipments-sheet columns A:D ───────────────────────

const REQUIRED_HEADERS = ['PicksheetNumber', 'ShipmentRef', 'ActualCollectionDate', 'TotalWeight'];

async function parseShipmentsUpload(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  // The upload is expected to be the Shipments sheet of the old workbook (or
  // an equivalent extract) — prefer a sheet literally named "Shipments", but
  // fall back to the first sheet so a simplified 4-column export still works.
  const ws = wb.getWorksheet('Shipments') || wb.worksheets[0];
  if (!ws) {
    const err = new Error('The uploaded file has no worksheets.');
    err.statusCode = 400;
    throw err;
  }

  const headerMap = buildHeaderMap(ws.getRow(1));
  const missing = REQUIRED_HEADERS.filter(h => !headerMap[h]);
  if (missing.length) {
    const err = new Error(
      `Missing expected column(s): ${missing.join(', ')}. Expected columns A:D = ${REQUIRED_HEADERS.join(', ')}, same layout as the Shipments tab of the old AT_Customs workbook.`
    );
    err.statusCode = 400;
    throw err;
  }

  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // header

    const picksheetNumber = readCellText(row, headerMap['PicksheetNumber']);
    if (!picksheetNumber) return;

    rows.push({
      picksheetNumber,
      shipmentRef: readCellText(row, headerMap['ShipmentRef']),
      actualCollectionDate: readCellDate(row, headerMap['ActualCollectionDate']),
      totalWeight: readCellNumber(row, headerMap['TotalWeight']),
    });
  });

  return rows;
}

// ── 2. SAP enrichment (3 rounds, straight to SapServer's /api/customs/* endpoints) ──
//
// Deliberately does NOT throw on a single round's failure or on empty
// intermediate results the way routes/shipmentmain.js's fetchSapCustomsData
// does for its ClearPort declaration use case (that one genuinely can't
// proceed with partial data) — this report is reviewed by a human before
// being sent on, so partial SAP data degrades individual lines rather than
// aborting the run. The one true hard-failure case is zero LIPS rows
// returned across the whole uploaded batch, since there's nothing at all to
// build a report from — and that error includes any warnings already
// collected, so a round that failed outright (network/auth/SapServer error)
// is never silently indistinguishable from "SAP genuinely has no data".

async function fetchCustomsReportSapData(deliveryNumbers) {
  const warnings = [];

  // Round 1 — parallel: LIPS (line items) + LIKP (header: incoterms, consignee)
  const [lipsData, likpData] = await Promise.all([
    sapPostArray('/api/customs/lips', { deliveries: deliveryNumbers }, 'LIPS', warnings),
    sapPostArray('/api/customs/likp', { deliveries: deliveryNumbers }, 'LIKP', warnings),
  ]);

  if (!lipsData.length) {
    const reason = warnings.length ? ` (${warnings.join('; ')})` : '';
    const err = new Error(`SAP returned no delivery line items (LIPS) for any of the uploaded delivery numbers${reason}. Verify the delivery numbers exist in SAP with plant 3012 and quantity > 0.`);
    err.statusCode = 422;
    throw err;
  }

  // Round 2 — parallel: VBFA (invoice/stat value/date) + MARC (commodity/origin) + KNA1 (name/country/VAT)
  const lineItems = lipsData.map(r => ({ delivery: r.deliveryNumber, item: r.itemNumber }));
  const materials = [...new Set(lipsData.map(r => String(r.materialNumber || '').trim()).filter(Boolean))];
  const customers = [...new Set(likpData.map(r => String(r.consigneeCode || '').trim()).filter(Boolean))];

  const [vbfaData, marcData, kna1Data] = await Promise.all([
    lineItems.length ? sapPostArray('/api/customs/vbfa', { lines: lineItems }, 'VBFA', warnings) : [],
    materials.length ? sapPostArray('/api/customs/marc', { materials }, 'MARC', warnings) : [],
    customers.length ? sapPostArray('/api/customs/kna1', { customers }, 'KNA1', warnings) : [],
  ]);

  // Round 3 — VBRK (currency), keyed by invoice numbers found in round 2.
  // Invoice Date comes from VBFA.invoiceDate (ERDAT) in round 2 instead —
  // that's the field the source workbook macro's own VBFA_Lookup routine
  // actually reads for it, confirmed against its real field list.
  const invoices = [...new Set(vbfaData.map(r => String(r.invoiceNumber || '').trim()).filter(Boolean))];
  const vbrkData = invoices.length ? await sapPostArray('/api/customs/vbrk', { invoices }, 'VBRK', warnings) : [];

  return { lipsData, likpData, vbfaData, marcData, kna1Data, vbrkData, warnings };
}

// Consignment-customer fallback: for report lines with no VBFA invoice (goods
// shipped without a commercial invoice), look up a customs sales price via
// SAP's pricing-condition tables instead. Only called for the (consignee,
// material) pairs that actually need it. Failures here are silent by design
// (an empty array — the caller already has a real warning-producing path for
// "no consignment price found") since this is itself a fallback within a
// fallback; a hard failure of the whole request over this one lookup would
// be disproportionate.
async function fetchConsignmentPrices(pairs) {
  if (!pairs.length) return [];
  const discard = [];
  return sapPostArray(
    '/api/customs/consignment-price',
    { lines: pairs.map(p => ({ customer: p.consigneeCode, material: p.material })) },
    'Consignment price',
    discard
  );
}

// ── 3. Assemble CUSTOMS-shaped rows ─────────────────────────────────────────

async function buildCustomsReportRows(shipmentRows, sapData) {
  const { lipsData, likpData, vbfaData, marcData, kna1Data, vbrkData } = sapData;
  const warnings = [...sapData.warnings];

  const likpByDelivery = new Map(likpData.map(r => [digits(r.deliveryNumber), r]));
  const marcByMaterial = new Map(marcData.map(r => [String(r.materialNumber || '').trim(), r]));
  const kna1ByCustomer = new Map(kna1Data.map(r => [digits(r.customerCode), r]));
  const vbrkByInvoice  = new Map(vbrkData.map(r => [digits(r.invoiceNumber), r]));
  const vbfaByLine     = new Map(vbfaData.map(r => [`${digits(r.deliveryNumber)}||${digits(r.itemNumber)}`, r]));

  // Sum TotalWeight per delivery (matches Excel SUMIFS semantics if the same
  // PicksheetNumber legitimately appears more than once in the upload); keep
  // the first ShipmentRef/ActualCollectionDate seen for that delivery.
  const shipmentByDelivery = new Map();
  for (const s of shipmentRows) {
    const key = digits(s.picksheetNumber);
    const existing = shipmentByDelivery.get(key);
    if (existing) {
      existing.totalWeight += s.totalWeight;
    } else {
      shipmentByDelivery.set(key, {
        shipmentRef: s.shipmentRef,
        actualCollectionDate: s.actualCollectionDate,
        totalWeight: s.totalWeight,
      });
    }
  }

  const foundDeliveries = new Set(lipsData.map(r => digits(r.deliveryNumber)));
  for (const s of shipmentRows) {
    if (!foundDeliveries.has(digits(s.picksheetNumber))) {
      warnings.push(`Delivery ${s.picksheetNumber}: no line items found in SAP (LIPS) — check the delivery number and plant.`);
    }
  }

  const rows = lipsData.map(lipsRow => {
    const deliveryKey = digits(lipsRow.deliveryNumber);
    const itemKey      = digits(lipsRow.itemNumber);
    const likpRow      = likpByDelivery.get(deliveryKey) || null;
    const vbfaRow       = vbfaByLine.get(`${deliveryKey}||${itemKey}`) || null;
    const marcRow       = marcByMaterial.get(String(lipsRow.materialNumber || '').trim()) || null;
    const consigneeKey  = likpRow ? digits(likpRow.consigneeCode) : '';
    const kna1Row       = consigneeKey ? kna1ByCustomer.get(consigneeKey) : null;
    const invoiceKey    = vbfaRow ? digits(vbfaRow.invoiceNumber) : null;
    const vbrkRow        = invoiceKey ? vbrkByInvoice.get(invoiceKey) : null;
    const shipment       = shipmentByDelivery.get(deliveryKey) || null;

    return {
      deliveryNumber:  deliveryKey,
      itemNumber:      itemKey,
      material:        String(lipsRow.materialNumber || '').trim(),
      quantity:        Number(lipsRow.quantity) || 0,
      invoiceNumber:   vbfaRow ? digits(vbfaRow.invoiceNumber) : '',
      currency:        vbrkRow?.currency?.trim() || '',
      salesValue:      vbfaRow ? Number(vbfaRow.statisticalValue) || 0 : null,
      commodityCode:   marcRow?.commodityCode?.trim() || '',
      countryOfOrigin: marcRow?.countryOfOrigin?.trim() || '',
      incoterms:       likpRow?.incoterms?.trim() || '',
      consigneeCode:   consigneeKey,
      name:            kna1Row?.name?.trim() || '',
      hsDescription:   '', // resolved below
      vatNumber:       kna1Row?.vatNumber?.trim() || '', // override fallback resolved below
      shipmentRef:     shipment?.shipmentRef || '',
      invoiceDate:     vbfaRow ? parseSapDate(vbfaRow.invoiceDate) : null,
      shipmentDate:    shipment?.actualCollectionDate || null,
      weight:          null, // apportioned below
      deliveryKey,
    };
  });

  // Consignment fallback — any row with no invoice at all (VBFA had nothing)
  // gets a customs sales price from SAP's pricing-condition tables instead,
  // keyed by (consignee, material). See fetchConsignmentPrices.
  const consignmentCandidates = rows.filter(r => !r.invoiceNumber && r.consigneeCode && r.material);
  if (consignmentCandidates.length) {
    const pairKey = r => `${r.consigneeCode}||${r.material}`;
    const uniquePairs = [...new Map(consignmentCandidates.map(r => [pairKey(r), { consigneeCode: r.consigneeCode, material: r.material }])).values()];
    const priceRows = await fetchConsignmentPrices(uniquePairs);
    const priceByPair = new Map(priceRows.map(p => [`${digits(p.customerCode)}||${String(p.materialNumber || '').trim()}`, p]));

    for (const row of consignmentCandidates) {
      const price = priceByPair.get(pairKey(row));
      if (price) {
        const rate = Number(price.rate) || 0;
        const pricingUnit = Number(price.pricingUnit) || 1;
        row.invoiceNumber = row.deliveryNumber; // placeholder — no real invoice for consignment shipments
        row.currency = price.currency?.trim() || '';
        row.salesValue = Math.round((rate / pricingUnit) * row.quantity * 100) / 100;
        row.invoiceDate = null;
      } else {
        warnings.push(`Delivery ${row.deliveryNumber} / Material ${row.material}: no invoice and no consignment price found in SAP.`);
      }
    }
  }

  // VAT number / HS description fallbacks — SAP-first, override-table-second.
  // Cached per key so a repeated consignee/commodity code across many lines
  // only costs one DB lookup.
  const vatCache = new Map();
  const hsCache = new Map();
  for (const row of rows) {
    if (!row.vatNumber && row.consigneeCode) {
      if (!vatCache.has(row.consigneeCode)) vatCache.set(row.consigneeCode, await lookupVatOverride(row.consigneeCode));
      row.vatNumber = vatCache.get(row.consigneeCode) || '';
    }
    if (row.commodityCode) {
      if (!hsCache.has(row.commodityCode)) hsCache.set(row.commodityCode, await lookupHsDescription(row.commodityCode));
      row.hsDescription = hsCache.get(row.commodityCode) || '';
    }
  }

  return { rows, warnings };
}

// ── 4. Weight apportionment ──────────────────────────────────────────────
//
// Replicates the workbook's exact formula:
//   ROUND(SUMIFS(Shipments!TotalWeight, Shipments!PicksheetNumber, thisDelivery)
//         / SUMIFS(CUSTOMS!Quantity, CUSTOMS!DeliveryNumber, thisDelivery)
//         * thisLineQuantity, 2)
// A pure function so it can be unit-tested directly against hand-computed
// fixtures without any SAP/DB mocking.

export function apportionWeights(reportLines, weightByDelivery) {
  const byDelivery = new Map();
  for (const line of reportLines) {
    if (!byDelivery.has(line.deliveryKey)) byDelivery.set(line.deliveryKey, []);
    byDelivery.get(line.deliveryKey).push(line);
  }

  for (const [deliveryKey, lines] of byDelivery) {
    const totalWeight = Number(weightByDelivery.get(deliveryKey)) || 0;
    const totalQty = lines.reduce((sum, l) => sum + (Number(l.quantity) || 0), 0);
    for (const line of lines) {
      line.weight = totalQty > 0
        ? Math.round((totalWeight / totalQty) * (Number(line.quantity) || 0) * 100) / 100
        : null;
    }
  }

  return reportLines;
}

// ── 5. Build the .xlsx ───────────────────────────────────────────────────

const HEADER_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
const HEADER_FONT  = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
const HEADER_ALIGN = { vertical: 'middle', horizontal: 'left' };
const BODY_FONT    = { name: 'Arial', size: 10, color: { argb: 'FF000000' } };
const EVEN_FILL    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
const ODD_FILL     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEF4' } };
const BORDER_STYLE = { style: 'thin', color: { argb: 'FFBFCAD4' } };
const CELL_BORDER  = { top: BORDER_STYLE, bottom: BORDER_STYLE, left: BORDER_STYLE, right: BORDER_STYLE };

const REPORT_COLUMNS = [
  { header: 'Delivery Number',    key: 'deliveryNumber' },
  { header: 'Delivery Item',      key: 'itemNumber' },
  { header: 'Material',           key: 'material' },
  { header: 'Quantity',           key: 'quantity' },
  { header: 'Invoice Number',     key: 'invoiceNumber' },
  { header: 'Currency',           key: 'currency' },
  { header: 'Sales Value',        key: 'salesValue' },
  { header: 'Commodity Code',     key: 'commodityCode' },
  { header: 'Country of Origin',  key: 'countryOfOrigin' },
  { header: 'Incoterms',          key: 'incoterms' },
  { header: 'Consignee Code',     key: 'consigneeCode' },
  { header: 'Name',               key: 'name' },
  { header: 'HS Description',     key: 'hsDescription' },
  { header: 'VAT No.',            key: 'vatNumber' },
  { header: 'Shipment Ref',       key: 'shipmentRef' },
  { header: 'Invoice Date',       key: 'invoiceDate' },
  { header: 'Shipment Date',      key: 'shipmentDate' },
  { header: 'Weight',             key: 'weight' },
];

function styleHeaderRow(row) {
  row.height = 22;
  row.eachCell(cell => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = HEADER_ALIGN;
    cell.border = CELL_BORDER;
  });
}

function styleDataRow(row, index) {
  const fill = index % 2 === 0 ? ODD_FILL : EVEN_FILL;
  row.eachCell(cell => {
    cell.font = BODY_FONT;
    cell.fill = fill;
    cell.border = CELL_BORDER;
  });
}

async function buildCustomsReportWorkbook(rows, warnings) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kongsberg Portal';
  wb.created = new Date();

  const ws = wb.addWorksheet('CUSTOMS');
  styleHeaderRow(ws.addRow(REPORT_COLUMNS.map(c => c.header)));

  rows.forEach((row, i) => {
    const values = REPORT_COLUMNS.map(c => {
      const v = row[c.key];
      if (v instanceof Date) return v;
      if (typeof v === 'number') return v;
      if (v === null || v === undefined) return '';
      return String(v);
    });
    styleDataRow(ws.addRow(values), i);
  });

  ws.columns.forEach((col, idx) => {
    let maxLen = REPORT_COLUMNS[idx].header.length;
    rows.forEach(row => {
      const v = row[REPORT_COLUMNS[idx].key];
      const text = v instanceof Date ? v.toISOString().slice(0, 10) : v;
      const len = text == null ? 0 : String(text).length;
      if (len > maxLen) maxLen = len;
    });
    col.width = Math.min(maxLen + 2, 52);
  });

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: REPORT_COLUMNS.length } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  if (warnings.length) {
    const warnWs = wb.addWorksheet('Warnings');
    styleHeaderRow(warnWs.addRow(['Warning']));
    warnings.forEach((w, i) => styleDataRow(warnWs.addRow([w]), i));
    warnWs.getColumn(1).width = 100;
  }

  return wb.xlsx.writeBuffer();
}

// ── Route ─────────────────────────────────────────────────────────────────

router.post('/generate',
  requirePermission('LOG_CUSTOMS_REPORT'),
  express.raw({
    type: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/octet-stream',
    ],
    limit: '20mb',
  }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ success: false, error: { message: 'No file content received.' } });
      }

      const shipmentRows = await parseShipmentsUpload(req.body);
      if (!shipmentRows.length) {
        return res.status(400).json({ success: false, error: { message: 'No data rows found in the uploaded file.' } });
      }

      const deliveryNumbers = shipmentRows.map(r => r.picksheetNumber);
      const sapData = await fetchCustomsReportSapData(deliveryNumbers);
      const { rows, warnings } = await buildCustomsReportRows(shipmentRows, sapData);

      const weightByDelivery = new Map();
      for (const s of shipmentRows) {
        const key = digits(s.picksheetNumber);
        weightByDelivery.set(key, (weightByDelivery.get(key) || 0) + s.totalWeight);
      }
      apportionWeights(rows, weightByDelivery);

      const buffer = await buildCustomsReportWorkbook(rows, warnings);
      const filename = `customs-report-${new Date().toISOString().slice(0, 10)}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.end(buffer);

      await audit('SAP_OK', actor(req), `Customs report generated: ${shipmentRows.length} shipment row(s), ${rows.length} line(s), ${warnings.length} warning(s)`, req);
    } catch (err) {
      console.error('[customsreport/generate]', err.message);
      await audit('SAP_ERROR', actor(req), `Customs report generation failed: ${err.message}`, req);
      if (!res.headersSent) {
        res.status(err.statusCode || 500).json({ success: false, error: { message: err.message } });
      }
    }
  }
);

export default router;
