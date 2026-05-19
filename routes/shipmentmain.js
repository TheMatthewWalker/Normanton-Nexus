import express from 'express';
import sql from 'mssql';
import axios from 'axios';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import net from 'net';
import tls from 'tls';
import { sqlConfig, stampDbChange } from '../server.js';
import { requirePermission } from '../middleware/auth.js';
import e from 'express';

const router = express.Router();
const getPool = async () => await sql.connect(sqlConfig);
const APP_CONFIG = loadAppConfig();


function loadAppConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')); }
  catch { return {}; }
}


function parseEmailList(value) {
  if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean);
  return String(value || '').split(/[;,]/).map(v => v.trim()).filter(Boolean);
}


function toBool(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'y'].includes(String(value ?? '').trim().toLowerCase());
}


function toNullableInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}


function toDecimal(value) {
  const parsed = Number.parseFloat(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}


// SAP returns numbers in European locale format, e.g. "16.676,20" (. = thousands, , = decimal)
function parseEuropeanDecimal(value) {
  const str = String(value ?? '').trim();
  const parsed = Number.parseFloat(str.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}


function normalizeDeliveryIds(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  return input.reduce((acc, item) => {
    const parsed = Number.parseInt(String(item), 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || seen.has(parsed)) return acc;
    seen.add(parsed);
    acc.push(parsed);
    return acc;
  }, []);
}


function normalizeIdList(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  return input.reduce((acc, item) => {
    const parsed = Number.parseInt(String(item), 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || seen.has(parsed)) return acc;
    seen.add(parsed);
    acc.push(parsed);
    return acc;
  }, []);
}


function normalizeShipmentUpdates(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  return input.reduce((acc, item) => {
    const shipmentID = Number.parseInt(String(item?.shipmentID), 10);
    if (!Number.isFinite(shipmentID) || shipmentID <= 0 || seen.has(shipmentID)) return acc;
    seen.add(shipmentID);
    acc.push({
      shipmentID,
      trackingNumber: String(item?.trackingNumber || '').trim(),
      plannedCollection: item?.plannedCollection ? new Date(item.plannedCollection) : null,
      forwarderID: item?.forwarderID === '' || item?.forwarderID == null ? null : Number.parseInt(String(item.forwarderID), 10),
    });
    return acc;
  }, []);
}


function createInClause(request, values, prefix) {
  return values.map((value, index) => {
    const key = `${prefix}${index}`;
    request.input(key, sql.BigInt, value);
    return `@${key}`;
  }).join(', ');
}
function formatShipmentRef(shipmentId) { return String(shipmentId).padStart(8, '0'); }
function sanitizeFolderSegment(value) {
  const clean = String(value || 'Unknown Customer').replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').trim();
  return clean || 'Unknown Customer';
}


function isExWorks(incoTerms) {
  const normalized = String(incoTerms || '').trim().toUpperCase();
  return normalized === 'EXW' || normalized === 'EX WORKS';
}


function getLogisticsSettings() {
  const logistics = APP_CONFIG.logistics || {};
  const email = logistics.email || {};
  return {
    exportRoot: process.env.LOGISTICS_EXPORT_ROOT || logistics.exportRoot || path.join(process.cwd(), 'exports', 'customer-invoices'),
    originID: toNullableInteger(process.env.LOGISTICS_ORIGIN_ID ?? logistics.originID),
    originName: process.env.LOGISTICS_ORIGIN_NAME || logistics.originName || 'Kongsberg Actuation System Ltd',
    originStreet: process.env.LOGISTICS_ORIGIN_STREET || logistics.originStreet || 'Euroflex Centre, Foxbridge Way',
    originCity: process.env.LOGISTICS_ORIGIN_CITY || logistics.originCity || 'Normanton',
    originPostCode: process.env.LOGISTICS_ORIGIN_POSTCODE || logistics.originPostCode || 'WF6 1TN',
    originCountry: process.env.LOGISTICS_ORIGIN_COUNTRY || logistics.originCountry || 'GB',
    smtpHost: process.env.LOGISTICS_SMTP_HOST || email.smtpHost || '',
    smtpPort: Number(process.env.LOGISTICS_SMTP_PORT || email.smtpPort || 25),
    smtpSecure: toBool(process.env.LOGISTICS_SMTP_SECURE ?? email.smtpSecure),
    smtpUser: process.env.LOGISTICS_SMTP_USER || email.smtpUser || '',
    smtpPass: process.env.LOGISTICS_SMTP_PASS || email.smtpPass || '',
    smtpHelloName: process.env.LOGISTICS_SMTP_HELLO_NAME || email.smtpHelloName || 'localhost',
    smtpConnectionTimeoutMs: Number(process.env.LOGISTICS_SMTP_TIMEOUT_MS || email.smtpTimeoutMs || 15000),
    smtpAllowInvalidCert: toBool(process.env.LOGISTICS_SMTP_ALLOW_INVALID_CERT ?? email.smtpAllowInvalidCert ?? true),
    mailFrom: process.env.LOGISTICS_EMAIL_FROM || email.from || '',
    mailCc: parseEmailList(process.env.LOGISTICS_EMAIL_CC || email.cc || []),
    mailBcc: parseEmailList(process.env.LOGISTICS_EMAIL_BCC || email.bcc || []),
  };
}


function getClearPortSettings() {
  const logistics = APP_CONFIG.logistics || {};
  const clearport = logistics.clearport || {};
  const ddpConf = clearport.ddpConsignee || {};
  const hasDdpConfig = Boolean(ddpConf.name || ddpConf.streetAndNumber);
  return {
    apiUrl: String(process.env.CLEARPORT_API_URL || clearport.apiUrl || 'https://api.clear-port.com').replace(/\/+$/, ''),
    apiToken: process.env.CLEARPORT_API_TOKEN || clearport.apiToken || '',
    sandbox: toBool(process.env.CLEARPORT_SANDBOX ?? clearport.sandbox),
    defaultCommodityCode: process.env.CLEARPORT_DEFAULT_COMMODITY_CODE || clearport.defaultCommodityCode || '39173900',
    defaultProcedure: process.env.CLEARPORT_DEFAULT_PROCEDURE || clearport.defaultProcedure || '1040',
    defaultAdditionalProcedure: process.env.CLEARPORT_DEFAULT_ADDITIONAL_PROCEDURE || clearport.defaultAdditionalProcedure || '000',
    defaultNatureOfTransaction: process.env.CLEARPORT_DEFAULT_NATURE || clearport.defaultNatureOfTransaction || '11',
    defaultCurrency: process.env.CLEARPORT_DEFAULT_CURRENCY || clearport.defaultCurrency || 'GBP',
    defaultPackageType: process.env.CLEARPORT_DEFAULT_PACKAGE_TYPE || clearport.defaultPackageType || 'PX',
    ddpConsignee: hasDdpConfig ? {
      name: String(ddpConf.name || '').trim() || null,
      streetAndNumber: String(ddpConf.streetAndNumber || '').trim() || null,
      cityName: String(ddpConf.cityName || '').trim() || null,
      postcode: String(ddpConf.postcode || '').trim() || null,
      countryCode: normalizeCountryCode(ddpConf.countryCode, 'GB'),
    } : null,
    eori:                                        process.env.CLEARPORT_EORI                                        || clearport.eori                                        || 'GB214987833000',
    locationOfGoods:                             process.env.CLEARPORT_LOCATION_OF_GOODS                           || clearport.locationOfGoods                             || 'GBAUDEUDEUDEUGVM',
    customsOfficeOfExit:                         process.env.CLEARPORT_CUSTOMS_OFFICE_OF_EXIT                      || clearport.customsOfficeOfExit                         || 'GB000060',
    rrs01Description:                            process.env.CLEARPORT_RRS01_DESCRIPTION                           || clearport.rrs01Description                            || 'Haulier',
    modeOfTransportAtBorder:                     Number(process.env.CLEARPORT_MODE_OF_TRANSPORT_AT_BORDER          ?? clearport.modeOfTransportAtBorder                    ?? 6),
    inlandModeOfTransport:                       Number(process.env.CLEARPORT_INLAND_MODE_OF_TRANSPORT             ?? clearport.inlandModeOfTransport                      ?? 3),
    typeOfTransportAtDeparture:                  Number(process.env.CLEARPORT_TYPE_OF_TRANSPORT_AT_DEPARTURE       ?? clearport.typeOfTransportAtDeparture                 ?? 30),
    identityOfTransportAtDeparture:              process.env.CLEARPORT_IDENTITY_OF_TRANSPORT_AT_DEPARTURE          || clearport.identityOfTransportAtDeparture               || 'UNKNOWN',
    typeOfActiveMeansOfTransportAtBorder:        Number(process.env.CLEARPORT_TYPE_OF_ACTIVE_MEANS_AT_BORDER       ?? clearport.typeOfActiveMeansOfTransportAtBorder        ?? 6),
    identityOfActiveMeansOfTransportAtBorder:    process.env.CLEARPORT_IDENTITY_OF_ACTIVE_MEANS_AT_BORDER          || clearport.identityOfActiveMeansOfTransportAtBorder     || 'UNKNOWN',
    nationalityOfActiveMeansOfTransportAtBorder: process.env.CLEARPORT_NATIONALITY_OF_ACTIVE_MEANS_AT_BORDER       || clearport.nationalityOfActiveMeansOfTransportAtBorder  || 'GB',
  };
}


function normalizeCountryCode(value, fallback = 'GB') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const upper = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  const map = {
    'UNITED KINGDOM': 'GB',
    'GREAT BRITAIN': 'GB',
    ENGLAND: 'GB',
    UK: 'GB',
    GERMANY: 'DE',
    FRANCE: 'FR',
    BELGIUM: 'BE',
    NETHERLANDS: 'NL',
    HOLLAND: 'NL',
    SPAIN: 'ES',
    ITALY: 'IT',
    POLAND: 'PL',
    CZECHIA: 'CZ',
    'CZECH REPUBLIC': 'CZ',
    SLOVAKIA: 'SK',
    SWEDEN: 'SE',
    NORWAY: 'NO',
    IRELAND: 'IE',
    'UNITED STATES': 'US',
    USA: 'US',
    INDIAL: 'IN',
    CHINA: 'CN',
  };
  return map[upper] || fallback;
}


function toNameAndAddress(name, street, city, postcode, countryCode) {
  return {
    name: String(name || '').trim() || null,
    streetAndNumber: String(street || '').trim() || null,
    cityName: String(city || '').trim() || null,
    postcode: String(postcode || '').trim() || null,
    countryCode: normalizeCountryCode(countryCode),
  };
}


function sanitizeFileSegment(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/[. ]+$/g, '')
    .trim() || 'document';
}


function escapePdfText(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\r?\n/g, ' ');
}


function hexToRgb(hex) {
  const normalized = String(hex || '').replace('#', '').trim();
  if (normalized.length !== 6) return [0, 0, 0];
  return [
    Number.parseInt(normalized.slice(0, 2), 16) / 255,
    Number.parseInt(normalized.slice(2, 4), 16) / 255,
    Number.parseInt(normalized.slice(4, 6), 16) / 255,
  ];
}


function wrapPdfText(text, maxChars) {
  const source = String(text || '').trim();
  if (!source) return [''];
  const words = source.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines;
}


function buildPdfFromPages(pageStreams) {
  const objects = new Map();
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.set(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const pageIds = [];
  let nextId = 5;
  for (const stream of pageStreams) {
    const contentId = nextId++;
    const pageId = nextId++;
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`);
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }
  objects.set(2, `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  const maxId = nextId - 1;
  for (let id = 1; id <= maxId; id += 1) {
    offsets[id] = Buffer.byteLength(pdf, 'utf8');
    pdf += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}


function createShipmentPackingListPdfBuffer(context) {
  const { shipment, deliveries, pallets } = context;
  const ref = formatShipmentRef(shipment.shipmentID);
  const plannedDate = shipment.plannedDelivery || shipment.plannedCollection;
  const linkedRefs = deliveries.map(row => String(row.deliveryID)).join(', ') || '-';
  const addressLines = [
    shipment.destinationName || '',
    shipment.destinationStreet || '',
    [shipment.destinationPostCode, shipment.destinationCity].filter(Boolean).join(' '),
    shipment.destinationCountry || '',
  ].filter(Boolean);
  const palette = {
    navy: hexToRgb('#0f2742'),
    steel: hexToRgb('#5b7088'),
    light: hexToRgb('#e8eef5'),
    soft: hexToRgb('#f7f9fc'),
    text: hexToRgb('#1c2733'),
    white: hexToRgb('#ffffff'),
    line: hexToRgb('#c7d3df'),
  };
  const rows = pallets.map(pallet => ({
    deliveryID: pallet.deliveryID || '',
    palletID: pallet.palletID || '',
    palletType: pallet.palletType || '',
    dimensions: `${pallet.palletLength || 0} x ${pallet.palletWidth || 0} x ${pallet.palletHeight || 0}`,
    grossWeight: `${formatDecimal(pallet.grossWeight)} KG`,
    netWeight: `${formatDecimal(Number(pallet.grossWeight || 0) - Number(pallet.packagingWeight || 0))} KG`,
    volume: `${formatDecimal(pallet.palletVolume)} CBM`,
    location: pallet.palletLocation || '',
  }));

  const pageStreams = [];
  const drawText = (parts, x, y, text, size = 10, font = 'F1', color = palette.text) => {
    const [r, g, b] = color;
    parts.push('BT');
    parts.push(`/${font} ${size} Tf`);
    parts.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
    parts.push(`1 0 0 1 ${x} ${y} Tm`);
    parts.push(`(${escapePdfText(text)}) Tj`);
    parts.push('ET');
  };
  const drawRect = (parts, x, y, w, h, color, fill = true) => {
    const [r, g, b] = color;
    parts.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
    parts.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`);
    parts.push(`${x} ${y} ${w} ${h} re`);
    parts.push(fill ? 'f' : 'S');
  };
  const drawLine = (parts, x1, y1, x2, y2, color = palette.line, width = 0.8) => {
    const [r, g, b] = color;
    parts.push(`${width} w`);
    parts.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`);
    parts.push(`${x1} ${y1} m`);
    parts.push(`${x2} ${y2} l`);
    parts.push('S');
  };
  const drawHeader = parts => {
    drawRect(parts, 0, 770, 595, 72, palette.navy, true);
    drawText(parts, 36, 808, 'Kongsberg Automotive', 20, 'F2', palette.white);
    drawText(parts, 36, 789, 'Shipment Packing List', 11, 'F1', palette.white);
    drawText(parts, 470, 804, `Ref ${ref}`, 14, 'F2', palette.white);

    drawRect(parts, 36, 640, 250, 108, palette.soft, true);
    drawRect(parts, 307, 640, 252, 108, palette.soft, true);
    drawText(parts, 48, 730, 'Delivery Address', 11, 'F2', palette.navy);
    addressLines.forEach((line, index) => drawText(parts, 48, 710 - (index * 15), line, 10));

    drawText(parts, 319, 730, 'Shipment Details', 11, 'F2', palette.navy);
    drawText(parts, 319, 709, `Forwarder: ${shipment.forwarderName || shipment.forwarderID || '-'}`, 10);
    drawText(parts, 319, 691, `Planned Date: ${plannedDate ? new Date(plannedDate).toLocaleDateString('en-GB') : '-'}`, 10);
    drawText(parts, 319, 673, `Tracking: ${shipment.trackingNumber || '-'}`, 10);

    drawRect(parts, 36, 590, 523, 34, palette.light, true);
    drawText(parts, 48, 602, `Linked Deliveries: ${linkedRefs}`, 10, 'F2', palette.navy);

    const cards = [
      { label: 'Pallet Count', value: `${formatDecimal(shipment.palletCount)}` },
      { label: 'Gross Weight', value: `${formatDecimal(shipment.grossWeight)} KG` },
      { label: 'Net Weight', value: `${formatDecimal(shipment.netWeight)} KG` },
      { label: 'Volume', value: `${formatDecimal(shipment.shipmentVolume)} CBM` },
    ];
    cards.forEach((card, index) => {
      const x = 36 + (index * 132);
      drawRect(parts, x, 534, 121, 42, palette.soft, true);
      drawText(parts, x + 12, 559, card.label, 9, 'F2', palette.steel);
      drawText(parts, x + 12, 542, card.value, 11, 'F2', palette.navy);
    });
  };
  const drawTableHeader = parts => {
    drawRect(parts, 36, 500, 523, 22, palette.navy, true);
    [
      ['Delivery', 42],
      ['Pallet', 92],
      ['Type', 138],
      ['Dimensions', 230],
      ['Gross', 332],
      ['Net', 388],
      ['Volume', 444],
      ['Location', 500],
    ].forEach(([label, x]) => drawText(parts, x, 507, label, 8.5, 'F2', palette.white));
  };
  const drawFooter = parts => {
    drawLine(parts, 36, 58, 559, 58, palette.line, 1);
    drawText(parts, 36, 44, 'Driver Collection Confirmation', 10, 'F2', palette.navy);
    drawText(parts, 36, 28, 'Haulage company name:', 9, 'F2', palette.text);
    drawText(parts, 330, 28, 'Reg:', 9, 'F2', palette.text);
    drawText(parts, 440, 28, 'Trailer No:', 9, 'F2', palette.text);
    drawText(parts, 36, 12, 'Driver name:', 9, 'F2', palette.text);
    drawText(parts, 330, 12, 'Date:', 9, 'F2', palette.text);
    drawLine(parts, 145, 26, 315, 26, palette.line, 0.8);
    drawLine(parts, 360, 26, 425, 26, palette.line, 0.8);
    drawLine(parts, 505, 26, 559, 26, palette.line, 0.8);
    drawLine(parts, 105, 10, 315, 10, palette.line, 0.8);
    drawLine(parts, 360, 10, 559, 10, palette.line, 0.8);
  };

  let rowIndex = 0;
  while (rowIndex < Math.max(rows.length, 1)) {
    const parts = [];
    drawHeader(parts);
    drawTableHeader(parts);
    let y = 480;
    if (!rows.length) {
      drawText(parts, 42, y, 'No pallets linked to this shipment.', 10);
      rowIndex = 1;
    } else {
      while (rowIndex < rows.length && y > 90) {
        const row = rows[rowIndex];
        if ((rowIndex % 2) === 0) drawRect(parts, 36, y - 4, 523, 18, palette.soft, true);
        drawText(parts, 42, y, row.deliveryID, 8.5);
        drawText(parts, 92, y, row.palletID, 8.5);
        drawText(parts, 138, y, row.palletType, 8.5);
        drawText(parts, 230, y, row.dimensions, 8.5);
        drawText(parts, 332, y, row.grossWeight, 8.5);
        drawText(parts, 388, y, row.netWeight, 8.5);
        drawText(parts, 444, y, row.volume, 8.5);
        drawText(parts, 500, y, row.location, 8.5);
        drawLine(parts, 36, y - 6, 559, y - 6);
        y -= 20;
        rowIndex += 1;
      }
    }
    if (rowIndex >= rows.length || !rows.length) drawFooter(parts);
    pageStreams.push(parts.join('\n'));
  }
  return buildPdfFromPages(pageStreams);
}

function createLoadingListPdfBuffer(shipmentsData) {
  const palette = {
    navy:  hexToRgb('#0f2742'),
    steel: hexToRgb('#5b7088'),
    light: hexToRgb('#e8eef5'),
    soft:  hexToRgb('#f7f9fc'),
    text:  hexToRgb('#1c2733'),
    white: hexToRgb('#ffffff'),
    line:  hexToRgb('#c7d3df'),
  };

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB');
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const drawText = (parts, x, y, text, size = 10, font = 'F1', color = palette.text) => {
    const [r, g, b] = color;
    parts.push(`BT /${font} ${size} Tf ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg 1 0 0 1 ${x} ${y} Tm (${escapePdfText(text)}) Tj ET`);
  };
  const drawRect = (parts, x, y, w, h, color, fill = true) => {
    const [r, g, b] = color;
    parts.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} ${fill ? 'rg' : 'RG'} ${x} ${y} ${w} ${h} re ${fill ? 'f' : 'S'}`);
  };
  const drawLine = (parts, x1, y1, x2, y2, color = palette.line, width = 0.5) => {
    const [r, g, b] = color;
    parts.push(`${width} w ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG ${x1} ${y1} m ${x2} ${y2} l S`);
  };
  const drawPageHeader = (parts, pageNum) => {
    drawRect(parts, 0, 800, 595, 42, palette.navy, true);
    drawText(parts, 36, 820, 'Kongsberg Automotive â€” Loading List', 13, 'F2', palette.white);
    drawText(parts, 36, 804, `Generated: ${dateStr} ${timeStr}`, 8.5, 'F1', palette.white);
    drawText(parts, 500, 812, `Page ${pageNum}`, 8.5, 'F1', palette.white);
  };
  const drawShipmentBand = (parts, y, shipment) => {
    const ref = formatShipmentRef(shipment.shipmentID);
    const planned = shipment.plannedCollection ? new Date(shipment.plannedCollection).toLocaleDateString('en-GB') : 'â€”';
    drawRect(parts, 36, y, 523, 20, palette.light, true);
    drawLine(parts, 36, y, 559, y, palette.navy, 1);
    drawText(parts, 42, y + 7,  `Shipment ${ref}`,                                              9, 'F2', palette.navy);
    drawText(parts, 155, y + 7, `Dest: ${String(shipment.destinationName || 'â€”').slice(0, 28)}`, 8, 'F1', palette.steel);
    drawText(parts, 355, y + 7, `Haulier: ${String(shipment.forwarderName || 'â€”').slice(0, 18)}`, 8, 'F1', palette.steel);
    drawText(parts, 475, y + 7, `Planned: ${planned}`,                                           8, 'F1', palette.steel);
  };
  const drawColHeaders = (parts, y) => {
    drawRect(parts, 36, y, 523, 16, palette.navy, true);
    [['Pallet ID', 42], ['Type', 120], ['Location', 195], ['Gross Wt', 305], ['Dimensions (LÃ—WÃ—H mm)', 385]].forEach(([label, x]) =>
      drawText(parts, x, y + 5, label, 7.5, 'F2', palette.white));
  };

  // Flatten all items into a printable sequence
  const allItems = [];
  for (const { shipment, pallets } of shipmentsData) {
    allItems.push({ kind: 'shipment', shipment });
    allItems.push({ kind: 'colheader' });
    pallets.forEach(pallet => allItems.push({ kind: 'pallet', pallet }));
    if (pallets.length === 0) allItems.push({ kind: 'empty' });
    allItems.push({ kind: 'gap' });
  }

  const HEIGHTS = { shipment: 22, colheader: 16, pallet: 15, empty: 15, gap: 10 };
  const TOP_Y   = 790;
  const BOT_Y   = 55;

  const pageStreams = [];
  let parts    = [];
  let y        = TOP_Y;
  let pageNum  = 1;
  let rowIndex = 0;

  drawPageHeader(parts, pageNum);

  const newPage = () => {
    pageStreams.push(parts.join('\n'));
    parts = [];
    pageNum++;
    y = TOP_Y;
    drawPageHeader(parts, pageNum);
  };

  for (const item of allItems) {
    const h = HEIGHTS[item.kind] || 15;
    // Keep shipment band + colheader + at least one row together
    const minHeight = item.kind === 'shipment' ? HEIGHTS.shipment + HEIGHTS.colheader + HEIGHTS.pallet : h;
    if (y - minHeight < BOT_Y) newPage();
    y -= h;

    if (item.kind === 'shipment') {
      drawShipmentBand(parts, y, item.shipment);
    } else if (item.kind === 'colheader') {
      drawColHeaders(parts, y);
    } else if (item.kind === 'pallet') {
      const { pallet } = item;
      if ((rowIndex % 2) === 0) drawRect(parts, 36, y, 523, 15, palette.soft, true);
      drawText(parts, 42,  y + 4, String(pallet.palletID    || ''),  8);
      drawText(parts, 120, y + 4, String(pallet.palletType  || ''),  8);
      drawText(parts, 195, y + 4, String(pallet.palletLocation || 'â€”'), 8);
      drawText(parts, 305, y + 4, `${formatDecimal(pallet.grossWeight)} kg`, 8);
      drawText(parts, 385, y + 4, `${pallet.palletLength || 0} Ã— ${pallet.palletWidth || 0} Ã— ${pallet.palletHeight || 0}`, 8);
      drawLine(parts, 36, y, 559, y);
      rowIndex++;
    } else if (item.kind === 'empty') {
      drawText(parts, 42, y + 4, 'No pallets linked to this shipment.', 8.5, 'F1', palette.steel);
    }
    // 'gap' is just space â€” nothing drawn
  }

  pageStreams.push(parts.join('\n'));
  return buildPdfFromPages(pageStreams);
}


function createSimplePdfBuffer(title, lines, fontBase = 'Helvetica') {
  const allLines = [String(title || '').trim(), '', ...lines.map(line => String(line ?? ''))];
  const pages = [];
  for (let i = 0; i < allLines.length; i += 44) pages.push(allLines.slice(i, i + 44));
  const objects = new Map();
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objects.set(3, `<< /Type /Font /Subtype /Type1 /BaseFont /${fontBase} >>`);
  const pageIds = [];
  let nextId = 4;
  for (const pageLines of pages) {
    const contentId = nextId++;
    const pageId = nextId++;
    const streamLines = ['BT', '/F1 11 Tf', '50 790 Td', '14 TL'];
    pageLines.forEach((line, index) => streamLines.push(`${index === 0 ? '' : 'T* '}(${escapePdfText(line)}) Tj`));
    streamLines.push('ET');
    const stream = streamLines.join('\n');
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`);
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }
  objects.set(2, `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  const maxId = nextId - 1;
  for (let id = 1; id <= maxId; id += 1) { offsets[id] = Buffer.byteLength(pdf, 'utf8'); pdf += `${id} 0 obj\n${objects.get(id)}\nendobj\n`; }
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}


async function getShipmentById(poolOrTx, shipmentId) {
  const result = await poolOrTx.request().input('shipmentId', sql.BigInt, shipmentId).query('SELECT * FROM Logistics.dbo.ShipmentMain WHERE shipmentID = @shipmentId');
  return result.recordset[0] || null;
}


async function getShipmentContext(shipmentId) {
  const pool = await getPool();
  const shipment = await getShipmentById(pool, shipmentId);
  if (!shipment) { const err = new Error(`Shipment ${shipmentId} not found.`); err.statusCode = 404; throw err; }
  if (shipment.forwarderID) {
    const forwarderResult = await pool.request()
      .input('forwarderId', sql.BigInt, shipment.forwarderID)
      .query('SELECT TOP 1 forwarderName FROM Logistics.dbo.Forwarders WHERE forwarderID = @forwarderId');
    shipment.forwarderName = forwarderResult.recordset[0]?.forwarderName || '';
  } else {
    shipment.forwarderName = '';
  }
  const deliveries = await pool.request().input('shipmentId', sql.BigInt, shipmentId).query(`
    SELECT dm.deliveryID, dm.customerID, dm.dueDate, dm.completionDate, dm.deliveryService, dm.picksheetComment, 
      CAST(ISNULL(dm.netWeight, 0) AS decimal(18,3)) AS netWeight, CAST(ISNULL(dm.grossWeight, 0) AS decimal(18,3)) AS grossWeight, 
      CAST(ISNULL(dm.palletCount, 0) AS decimal(18,3)) AS palletCount, CAST(ISNULL(dm.deliveryVolume, 0) AS decimal(18,3)) AS deliveryVolume, 
      d.destinationName, d.destinationStreet, d.destinationCity, d.destinationPostCode, d.destinationCountry, 
    STUFF((
      SELECT '; ' + e.address
      FROM Logistics.dbo.Email e
      WHERE e.ID = dm.customerID
      FOR XML PATH('')
    ), 1, 2, '') AS destinationEmail
    FROM Logistics.dbo.ShipmentLink sl 
      INNER JOIN Logistics.dbo.DeliveryMain dm ON dm.deliveryID = sl.deliveryID 
      LEFT JOIN Logistics.dbo.Destinations d ON dm.customerID = d.destinationID 
    WHERE sl.shipmentID = @shipmentId ORDER BY dm.deliveryID ASC`);
  const pallets = await pool.request().input('shipmentId', sql.BigInt, shipmentId).query(`SELECT sl.deliveryID, pm.palletID, pm.palletType, pm.palletFinish, CAST(ISNULL(pm.packagingWeight, 0) AS decimal(18,3)) AS packagingWeight, CAST(ISNULL(pm.grossWeight, 0) AS decimal(18,3)) AS grossWeight, CAST(ISNULL(pm.palletVolume, 0) AS decimal(18,3)) AS palletVolume, pm.palletLength, pm.palletWidth, pm.palletHeight, pm.palletLocation FROM Logistics.dbo.ShipmentLink sl INNER JOIN Logistics.dbo.DeliveryLink dl ON dl.deliveryID = sl.deliveryID INNER JOIN Logistics.dbo.PalletMain pm ON pm.palletID = dl.palletID WHERE sl.shipmentID = @shipmentId AND ISNULL(pm.palletRemoved, 0) = 0 ORDER BY sl.deliveryID ASC, pm.palletID ASC`);
  return { shipment, deliveries: deliveries.recordset, pallets: pallets.recordset };
}


function buildClearPortShipmentPayload(context, sapData) {
  const clearPort = getClearPortSettings();
  const { shipment, deliveries } = context;
  const { lipsData, likpData, vbfaData, marcData } = sapData;

  if (!deliveries.length) {
    const err = new Error(`Shipment ${shipment.shipmentID} has no linked deliveries for customs submission.`);
    err.statusCode = 400;
    throw err;
  }
  if (!lipsData.length) {
    const err = new Error(`No SAP line items (LIPS) returned for shipment ${shipment.shipmentID}. Verify delivery numbers exist in SAP.`);
    err.statusCode = 422;
    throw err;
  }

  const shipmentRef = formatShipmentRef(shipment.shipmentID);
  const originCountry = normalizeCountryCode(shipment.originCountry, 'GB');
  const destinationCountry = normalizeCountryCode(shipment.destinationCountry, 'GB');
  const exporter = toNameAndAddress(shipment.originName, shipment.originStreet, shipment.originCity, shipment.originPostCode, shipment.originCountry);
  const declarant = toNameAndAddress(process.env.LOGISTICS_ORIGIN_NAME, process.env.LOGISTICS_ORIGIN_STREET, process.env.LOGISTICS_ORIGIN_CITY, process.env.LOGISTICS_ORIGIN_POSTCODE, process.env.LOGISTICS_ORIGIN_COUNTRY);
  const destinationConsignee = toNameAndAddress(shipment.destinationName, shipment.destinationStreet, shipment.destinationCity, shipment.destinationPostCode, shipment.destinationCountry);
  const carrier = shipment.forwarderName ? toNameAndAddress(shipment.forwarderName, '', '', '', shipment.originCountry) : null;

  // Lookup maps keyed for O(1) access
  const marcMap = new Map(marcData.map(r => [String(r.materialNumber || '').trim(), r]));
  const vbfaMap = new Map(vbfaData.map(r => [`${r.deliveryNumber}-${r.itemNumber}`, r]));
  const likpMap = new Map(likpData.map(r => [String(r.deliveryNumber || '').trim(), r]));

  // Map SAP delivery number back to our DB delivery row.
  // SAP delivery numbers can come back in several formats depending on the SAP server:
  //   plain ID ("12345"), "00" prefix ("0012345"), or 10-char zero-padded ("0000012345").
  // Index under all three so the lookup is format-agnostic.
  const deliveryBySapNumber = new Map();
  for (const delivery of deliveries) {
    const id = String(delivery.deliveryID);
    deliveryBySapNumber.set(id, delivery);
    deliveryBySapNumber.set('00' + id, delivery);
    deliveryBySapNumber.set(id.padStart(10, '0'), delivery);
  }

  // Count LIPS rows per SAP delivery for proportional weight/pallet distribution
  const lipsCountByDelivery = new Map();
  for (const line of lipsData) {
    lipsCountByDelivery.set(line.deliveryNumber, (lipsCountByDelivery.get(line.deliveryNumber) || 0) + 1);
  }

  // Enrich each LIPS line with all lookup data, distributing weights proportionally
  const enrichedLines = lipsData.map(line => {
    const marc = marcMap.get(String(line.materialNumber || '').trim()) || {};
    const vbfa = vbfaMap.get(`${line.deliveryNumber}-${line.itemNumber}`) || {};
    const likp = likpMap.get(line.deliveryNumber) || {};
    const delivery = deliveryBySapNumber.get(line.deliveryNumber);
    const linesForDelivery = lipsCountByDelivery.get(line.deliveryNumber) || 1;

    return {
      deliveryNumber:   line.deliveryNumber,
      invoiceNumber:    String(vbfa.invoiceNumber || '').trim(),
      commodityCode:    String(marc.commodityCode || clearPort.defaultCommodityCode || '').trim(),
      countryOfOrigin:  normalizeCountryCode(marc.countryOfOrigin, originCountry),
      incoterms:        String(likp.incoterms || shipment.incoTerms || '').trim().toUpperCase(),
      statisticalValue: parseEuropeanDecimal(vbfa.statisticalValue),
      grossMass:        delivery ? toDecimal(delivery.grossWeight) / linesForDelivery : 0,
      netMass:          delivery ? toDecimal(delivery.netWeight)   / linesForDelivery : 0,
      packageCount:     delivery ? toDecimal(delivery.palletCount) / linesForDelivery : 0,
    };
  });

  // Group by delivery number then commodity code, collecting all invoice numbers per group
  const groups = new Map();
  for (const line of enrichedLines) {
    const key = `${line.deliveryNumber}|${line.commodityCode}`;
    if (!groups.has(key)) {
      groups.set(key, {
        deliveryNumber:  line.deliveryNumber,
        commodityCode:   line.commodityCode,
        countryOfOrigin: line.countryOfOrigin,
        incoterms:       line.incoterms,
        invoiceNumbers:  new Set(),
        statisticalValue: 0,
        grossMass:        0,
        netMass:          0,
        packageCount:     0,
      });
    }
    const group = groups.get(key);
    if (line.invoiceNumber) group.invoiceNumbers.add(line.invoiceNumber);
    group.statisticalValue += line.statisticalValue;
    group.grossMass        += line.grossMass;
    group.netMass          += line.netMass;
    group.packageCount     += line.packageCount;
  }

  const items = Array.from(groups.values()).map((group, index) => {
    const isDdpItem = group.incoterms === 'DDP';
    const itemConsignee = isDdpItem && clearPort.ddpConsignee ? clearPort.ddpConsignee : destinationConsignee;
    const previousDocuments = [...group.invoiceNumbers].map(inv => ({
      category:          'Z',
      type:              '380',
      documentReference: inv,
      //goodsItemIdentifier: '',
    }));

    return {
      correlationId:    `${shipmentRef}-${String(index + 1).padStart(3, '0')}`,
      referenceNumber:  group.deliveryNumber,
      commodityCode:                group.commodityCode,
      procedure:        clearPort.defaultProcedure,
      additionalProcedures:        clearPort.defaultAdditionalProcedure,
      //consignee:        itemConsignee,
      countryOfDestination: destinationCountry,
      countryOfOrigin:  group.countryOfOrigin,
      netMass:          group.netMass,
      grossMass:        group.grossMass,
      descriptionOfGoods: `PTFE Hose`,
      packages: [{
        type:          clearPort.defaultPackageType,
        number:        Math.max(1, Math.round(group.packageCount)),
        shippingMarks: 'As Addressed',
      }],
      natureOfTransaction:          clearPort.defaultNatureOfTransaction,
      statisticalValue:             Math.round(group.statisticalValue, 2),
      statisticalValueCurrencyCode: clearPort.defaultCurrency,
      previousDocuments,
      additionalInformation: [],
    };
  });

  // Header-level consignee: DDP if all items are DDP, otherwise destination
  const allDdp = items.length > 0 && enrichedLines.every(l => l.incoterms === 'DDP');
  const headerConsignee = allDdp && clearPort.ddpConsignee ? clearPort.ddpConsignee : destinationConsignee;
  const totalInvoice = Math.round(enrichedLines.reduce((sum, l) => sum + l.statisticalValue, 0), 2);

  return {
    sandbox:              clearPort.sandbox,
    correlationId:        `${shipmentRef}-${Date.now()}`,
    externalSystemLink:   `/private/logistics.html?shipment=${encodeURIComponent(shipment.shipmentID)}`,
    category:             'B1',
    declarationType:      'EXA',
    referenceNumber:      shipmentRef,
    lrn:                  shipmentRef,
    ducr:                 new Date().getFullYear().toString().slice(-1) + process.env.CLEARPORT_EORI + '-' + shipmentRef,
    exporter,
    exporterIdentificationNumber:                 clearPort.eori,
    consignee:                                    headerConsignee,
    declarant,
    declarantIdentificationNumber:                clearPort.eori,
    representativeStatusCode:                     2,
    //carrier,
    transportChargesMethodOfPayment:              '',
    totalInvoice,
    totalInvoiceCurrencyCode:                     clearPort.defaultCurrency,
    countryOfDestination:                         destinationCountry,
    countryOfDispatch:                            originCountry,
    locationOfGoods:                              clearPort.locationOfGoods,
    customsOfficeOfExit:                          clearPort.customsOfficeOfExit,
    totalGrossMass:                               toDecimal(shipment.grossWeight),
    totalNetMass:                                 toDecimal(shipment.netWeight),
    totalPackages:                                Math.max(1, Math.round(toDecimal(shipment.palletCount))),
    containerised:                                false,
    natureOfTransaction:                          clearPort.defaultNatureOfTransaction,
    rrs01:                                        true,
    rrs01Description:                             clearPort.rrs01Description,
    modeOfTransportAtBorder:                      clearPort.modeOfTransportAtBorder,
    inlandModeOfTransport:                        clearPort.inlandModeOfTransport,
    typeOfTransportAtDeparture:                   clearPort.typeOfTransportAtDeparture,
    identityOfTransportAtDeparture:               clearPort.identityOfTransportAtDeparture,
    typeOfActiveMeansOfTransportAtBorder:         clearPort.typeOfActiveMeansOfTransportAtBorder,
    identityOfActiveMeansOfTransportAtBorder:     clearPort.identityOfActiveMeansOfTransportAtBorder,
    nationalityOfActiveMeansOfTransportAtBorder:  clearPort.nationalityOfActiveMeansOfTransportAtBorder,
    holdersOfAuthorisation: [{ authorisationTypeCode: 'EXRR', identifier: clearPort.eori }],
    items,
  };
}


function unwrapSapArray(body) {
  if (Array.isArray(body)) return body;
  if (body?.success && Array.isArray(body.data)) return body.data;
  return [];
}


async function fetchSapCustomsData(deliveries, req) {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const headers = { 'Content-Type': 'application/json', ...(req.headers.cookie ? { Cookie: req.headers.cookie } : {}) };

  const sapPost = (path, body) => fetch(`${baseUrl}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  }).then(r => r.json());

  const sapDeliveryNumbers = deliveries.map(d => String(d.deliveryID));

  // Round 1 â€” parallel: LIPS (line items) + LIKP (delivery header: incoterms, consignee code)
  const [lipsBody, likpBody] = await Promise.all([
    sapPost('/api/sap/lips', { deliveries: sapDeliveryNumbers }),
    sapPost('/api/sap/likp', { deliveries: sapDeliveryNumbers }),
  ]);

  if (lipsBody?.success === false) {
    const err = new Error(`SAP LIPS query failed: ${lipsBody.error || 'unknown error'}`);
    err.statusCode = 502;
    throw err;
  }
  if (likpBody?.success === false) {
    const err = new Error(`SAP LIKP query failed: ${likpBody.error || 'unknown error'}`);
    err.statusCode = 502;
    throw err;
  }

  const lipsData = unwrapSapArray(lipsBody);
  const likpData = unwrapSapArray(likpBody);

  console.group('[SAP customs] Round 1 results');
  console.log('LIPS raw:', JSON.stringify(lipsData, null, 2));
  console.log('LIKP raw:', JSON.stringify(likpData, null, 2));
  console.groupEnd();

  if (!lipsData.length) {
    const err = new Error('SAP returned no delivery line items (LIPS). Verify delivery numbers exist in SAP with WERKS 3012 and quantity > 0.');
    err.statusCode = 422;
    throw err;
  }

  // Round 2 â€” parallel: VBFA (invoice/stat value per line) + MARC (commodity/origin per material) + KNA1 (customer country)
  const lineItems = lipsData.map(r => ({ delivery: r.deliveryNumber, item: r.itemNumber }));
  const materials = [...new Set(lipsData.map(r => String(r.materialNumber || '').trim()).filter(Boolean))];
  const customers = [...new Set(likpData.map(r => String(r.consigneeCode || '').trim()).filter(Boolean))];

  const [vbfaBody, marcBody, kna1Body] = await Promise.all([
    sapPost('/api/sap/vbfa', { lines: lineItems }),
    materials.length ? sapPost('/api/sap/marc', { materials }) : Promise.resolve({ success: true, data: [] }),
    customers.length ? sapPost('/api/sap/kna1', { customers }) : Promise.resolve({ success: true, data: [] }),
  ]);

  const vbfaData = unwrapSapArray(vbfaBody);
  const marcData = unwrapSapArray(marcBody);
  const kna1Data = unwrapSapArray(kna1Body);

  console.group('[SAP customs] Round 2 results');
  console.log('VBFA lineItems sent:', JSON.stringify(lineItems, null, 2));
  console.log('VBFA raw:', JSON.stringify(vbfaData, null, 2));
  console.log('MARC raw:', JSON.stringify(marcData, null, 2));
  console.groupEnd();

  if (vbfaBody?.success === false) {
    const err = new Error(`SAP VBFA query failed: ${vbfaBody.error || 'unknown error'}`);
    err.statusCode = 502;
    throw err;
  }

  return { lipsData, likpData, vbfaData, marcData, kna1Data };
}


async function createClearPortExport(payload) {
  const clearPort = getClearPortSettings();
  if (!clearPort.apiToken) {
    const err = new Error('ClearPort integration is not configured. Set CLEARPORT_API_TOKEN in .env.');
    err.statusCode = 503;
    throw err;
  }

  const url = `${clearPort.apiUrl}/v1/cds/exports`;
  try {
    console.group('[ClearPort] POST /v1/cds/exports');
    console.log('Request payload:', JSON.stringify(payload, null, 2));

    const response = await axios.post(url, payload, {
      timeout: 30000,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-API-Key': clearPort.apiToken,
      },
      validateStatus: () => true,
      transformResponse: [(data) => data],  // skip auto-parse â€” keep raw text
    });

    // Parse manually so we capture the body regardless of Content-Type
    let rawBody = String(response.data ?? '');
    let parsedBody = null;
    try { parsedBody = JSON.parse(rawBody); } catch (_) { /* not JSON */ }

    console.log('Response status:', response.status);
    console.log('Response headers:', JSON.stringify(response.headers, null, 2));
    console.log('Response body:', rawBody || '(empty)');
    console.groupEnd();

    if (response.status === 401) {
      const err = new Error('ClearPort rejected the API token.');
      err.statusCode = 502;
      throw err;
    }
    if (response.status === 429) {
      const err = new Error('ClearPort rate limit reached. Please retry shortly.');
      err.statusCode = 429;
      throw err;
    }
    if (response.status < 200 || response.status >= 300) {
      const detail = rawBody || `HTTP ${response.status} with no response body`;
      const err = new Error(`ClearPort create failed (${response.status}): ${detail}`);
      err.statusCode = 502;
      throw err;
    }

    const body = parsedBody || {};
    if (body.success === false) {
      const detail = Array.isArray(body.errorMessages) && body.errorMessages.length
        ? body.errorMessages.join(' | ')
        : 'ClearPort rejected the customs declaration.';
      const err = new Error(detail);
      err.statusCode = 502;
      throw err;
    }
    const correlationId = String(body.correlationId || payload.correlationId || '').trim();
    if (!correlationId) {
      const err = new Error('ClearPort did not return a correlationId.');
      err.statusCode = 502;
      throw err;
    }
    return { correlationId, response: body };
  } catch (err) {
    console.groupEnd();
    if (!err.statusCode) {
      err.statusCode = 502;
      err.message = `Could not reach ClearPort API: ${err.message}`;
    }
    throw err;
  }
}


async function downloadClearPortPdf(correlationId) {
  const clearPort = getClearPortSettings();
  if (!clearPort.apiToken) {
    const err = new Error('ClearPort integration is not configured. Set CLEARPORT_API_TOKEN in .env.');
    err.statusCode = 503;
    throw err;
  }

  const url = `${clearPort.apiUrl}/v1/cds/exports/${encodeURIComponent(correlationId)}/pdf`;
  try {
    console.group('[ClearPort] GET /v1/cds/exports/:correlationId/pdf');
    console.log('URL:', url);

    const response = await axios.get(url, {
      timeout: 30000,
      headers: {
        Accept: 'application/pdf',
        'X-API-Key': clearPort.apiToken,
      },
      responseType: 'arraybuffer',
      validateStatus: () => true,
    });

    console.log('Response status:', response.status);
    if (response.status < 200 || response.status >= 300) {
      const bodyText = Buffer.from(response.data).toString('utf8');
      console.error('Response body (error):', bodyText);
    }
    console.groupEnd();

    if (response.status === 401) {
      const err = new Error('ClearPort rejected the API token while downloading the customs PDF.');
      err.statusCode = 502;
      throw err;
    }
    if (response.status === 404) {
      const err = new Error(`ClearPort could not find declaration ${correlationId}.`);
      err.statusCode = 404;
      throw err;
    }
    if (response.status === 429) {
      const err = new Error('ClearPort rate limit reached while downloading the customs PDF.');
      err.statusCode = 429;
      throw err;
    }
    if (response.status < 200 || response.status >= 300) {
      const err = new Error(`ClearPort PDF download failed (${response.status}).`);
      err.statusCode = 502;
      throw err;
    }

    return Buffer.from(response.data);
  } catch (err) {
    console.groupEnd();
    if (!err.statusCode) {
      err.statusCode = 502;
      err.message = `Could not download customs PDF: ${err.message}`;
    }
    throw err;
  }
}


function getShipmentFolderInfo(shipment) {
  const settings = getLogisticsSettings();
  const shipmentRef = formatShipmentRef(shipment.shipmentID);
  const customerPath = path.join(settings.exportRoot, sanitizeFolderSegment(shipment.destinationName || 'Unknown Customer'));
  return { shipmentRef, customerPath, shipmentPath: path.join(customerPath, shipmentRef) };
}


async function ensureShipmentFolder(shipment) {
  const folder = getShipmentFolderInfo(shipment);
  await fsp.mkdir(folder.customerPath, { recursive: true });
  await fsp.mkdir(folder.shipmentPath, { recursive: true });
  return folder;
}


function round3(value) {
  return Number(formatDecimal(value));
}


async function writeShipmentEvent(pool, shipmentId, category, description) {
  await pool.request()
    .input('shipmentId',  sql.BigInt,        shipmentId)
    .input('category',    sql.NVarChar(50),  category)
    .input('description', sql.NVarChar(500), description)
    .query(`INSERT INTO Logistics.dbo.ShipmentEvents (shipmentID, eventCategory, eventDescription)
            VALUES (@shipmentId, @category, @description)`);
}


async function syncShipmentAggregateData(shipmentId) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const deliveryResult = await tx.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .query('SELECT deliveryID FROM Logistics.dbo.ShipmentLink WHERE shipmentID = @shipmentId');
    const palletResult = await tx.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .query(`
        SELECT
          sl.deliveryID,
          pm.palletID,
          CAST(ISNULL(pm.packagingWeight, 0) AS decimal(18,3)) AS packagingWeight,
          CAST(ISNULL(pm.grossWeight, 0) AS decimal(18,3)) AS grossWeight,
          CAST(ISNULL(pm.palletVolume, 0) AS decimal(18,3)) AS palletVolume
        FROM Logistics.dbo.ShipmentLink sl
        INNER JOIN Logistics.dbo.DeliveryLink dl ON dl.deliveryID = sl.deliveryID
        INNER JOIN Logistics.dbo.PalletMain pm ON pm.palletID = dl.palletID
        WHERE sl.shipmentID = @shipmentId
          AND ISNULL(pm.palletRemoved, 0) = 0
        ORDER BY sl.deliveryID ASC, pm.palletID ASC`);

    const deliveryTotals = new Map();
    for (const row of deliveryResult.recordset) {
      deliveryTotals.set(Number(row.deliveryID), {
        palletCount: 0,
        grossWeight: 0,
        netWeight: 0,
        deliveryVolume: 0,
      });
    }
    for (const pallet of palletResult.recordset) {
      const deliveryId = Number(pallet.deliveryID);
      const totals = deliveryTotals.get(deliveryId);
      totals.palletCount += 1;
      totals.grossWeight += Number(pallet.grossWeight || 0);
      totals.netWeight += Number(pallet.grossWeight || 0) - Number(pallet.packagingWeight || 0);
      totals.deliveryVolume += Number(pallet.palletVolume || 0);
    }

    let shipmentGrossWeight = 0;
    let shipmentNetWeight = 0;
    let shipmentPalletCount = 0;
    let shipmentVolume = 0;

    for (const [deliveryId, totals] of deliveryTotals.entries()) {
      shipmentGrossWeight += totals.grossWeight;
      shipmentNetWeight += totals.netWeight;
      shipmentPalletCount += totals.palletCount;
      shipmentVolume += totals.deliveryVolume;

      await tx.request()
        .input('deliveryId', sql.BigInt, deliveryId)
        .input('palletCount', sql.Decimal(18, 3), round3(totals.palletCount))
        .input('grossWeight', sql.Decimal(18, 3), round3(totals.grossWeight))
        .input('netWeight', sql.Decimal(18, 3), round3(totals.netWeight))
        .input('deliveryVolume', sql.Decimal(18, 3), round3(totals.deliveryVolume))
        .query(`
          UPDATE Logistics.dbo.DeliveryMain
          SET
            palletCount = @palletCount,
            grossWeight = @grossWeight,
            netWeight = @netWeight,
            deliveryVolume = @deliveryVolume
          WHERE deliveryID = @deliveryId`);
    }

    await tx.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .input('palletCount', sql.Decimal(18, 3), round3(shipmentPalletCount))
      .input('grossWeight', sql.Decimal(18, 3), round3(shipmentGrossWeight))
      .input('netWeight', sql.Decimal(18, 3), round3(shipmentNetWeight))
      .input('shipmentVolume', sql.Decimal(18, 3), round3(shipmentVolume))
      .query(`
        UPDATE Logistics.dbo.ShipmentMain
        SET
          palletCount = @palletCount,
          grossWeight = @grossWeight,
          netWeight = @netWeight,
          shipmentVolume = @shipmentVolume
        WHERE shipmentID = @shipmentId`);

    await tx.commit();
  } catch (err) {
    try { await tx.rollback(); } catch (_) {}
    throw err;
  }

  return getShipmentContext(shipmentId);
}


function applySiteMatch(request, fieldPrefix, settings, idParamName, nameParamName) {
  request.input(idParamName, sql.BigInt, settings.originID);
  request.input(nameParamName, sql.NVarChar, settings.originName);
  return `( (@${idParamName} IS NOT NULL AND ${fieldPrefix}ID = @${idParamName}) OR (${fieldPrefix}Name = @${nameParamName}) )`;
}


function buildShipmentQueueFilter(mode, request, settings) {
  if (mode === 'awaiting-collection') {
    return `
      ISNULL(sm.shipmentCancelled, 0) = 0
      AND ISNULL(sm.bookingStatus,    0) = 1
      AND ISNULL(sm.collectionStatus, 0) = 0
      AND ${applySiteMatch(request, 'sm.origin', settings, 'originSiteId', 'originSiteName')}
    `;
  }

  if (mode === 'inbound') {
    return `
      ISNULL(sm.shipmentCancelled, 0) = 0
      AND ISNULL(sm.collectionStatus, 0) = 1
      AND ISNULL(sm.deliveryStatus, 0) = 0
      AND ${applySiteMatch(request, 'sm.destination', settings, 'destinationSiteId', 'destinationSiteName')}
    `;
  }

  if (mode === 'in-transit') {
    return `
      ISNULL(sm.shipmentCancelled, 0) = 0
      AND ISNULL(sm.collectionStatus, 0) = 1
      AND ISNULL(sm.deliveryStatus, 0) = 0
      AND ${applySiteMatch(request, 'sm.origin', settings, 'transitOriginSiteId', 'transitOriginSiteName')}
    `;
  }

  if (mode === 'awaiting-booking') {
    return `
      ISNULL(sm.shipmentCancelled, 0) = 0
      AND ISNULL(sm.bookingStatus, 0) = 0
    `;
  }

  if (mode === 'customs-docs') {
    return `
      ISNULL(sm.shipmentCancelled, 0) = 0
      AND ISNULL(sm.customsRequired, 0) = 1
      AND ISNULL(sm.customsComplete, 0) = 0
    `;
  }

  const err = new Error('Invalid shipment queue mode.');
  err.statusCode = 400;
  throw err;
}


function formatDecimal(value, decimals = 3) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed.toFixed(decimals) : (0).toFixed(decimals);
}


function buildShipmentPackingListLines(context) {
  const { shipment, deliveries, pallets } = context;
  const ref = formatShipmentRef(shipment.shipmentID);
  const plannedDate = shipment.plannedDelivery || shipment.plannedCollection;
  const deliveryRefs = deliveries.map(row => row.deliveryID).join(', ');
  const headerAddress = [shipment.destinationStreet, shipment.destinationCity, shipment.destinationPostCode, shipment.destinationCountry].filter(Boolean).join(', ');
  const divider = ''.padEnd(118, '=');
  const section = ''.padEnd(118, '-');
  const palletHeader = [
    'Delivery'.padEnd(10),
    'Pallet'.padEnd(10),
    'Type'.padEnd(18),
    'Dimensions'.padEnd(18),
    'Gross KG'.padStart(10),
    'Net KG'.padStart(10),
    'Vol CBM'.padStart(10),
    'Location'.padEnd(24),
  ].join(' ');
  const palletLines = pallets.length
    ? pallets.map(pallet => {
        const netWeight = Number(pallet.grossWeight || 0) - Number(pallet.packagingWeight || 0);
        const dimensions = `${pallet.palletLength || 0}x${pallet.palletWidth || 0}x${pallet.palletHeight || 0}`;
        return [
          String(pallet.deliveryID || '').padEnd(10),
          String(pallet.palletID || '').padEnd(10),
          String(pallet.palletType || '').slice(0, 18).padEnd(18),
          dimensions.slice(0, 18).padEnd(18),
          formatDecimal(pallet.grossWeight).padStart(10),
          formatDecimal(netWeight).padStart(10),
          formatDecimal(pallet.palletVolume).padStart(10),
          String(pallet.palletLocation || '').slice(0, 24).padEnd(24),
        ].join(' ');
      })
    : ['No pallets linked to this shipment.'];

  return [
    divider,
    `Address: ${shipment.destinationName || ''}${headerAddress ? `, ${headerAddress}` : ''}`,
    `Ref: ${ref}`,
    `Forwarder: ${shipment.forwarderName || shipment.forwarderID || ''}`,
    `Planned Date: ${plannedDate ? new Date(plannedDate).toLocaleDateString('en-GB') : ''}`,
    divider,
    `Linked Deliveries: ${deliveryRefs || '-'}`,
    `Pallet Count: ${formatDecimal(shipment.palletCount)} | Gross Weight: ${formatDecimal(shipment.grossWeight)} KG | Net Weight: ${formatDecimal(shipment.netWeight)} KG | Volume: ${formatDecimal(shipment.shipmentVolume)} CBM`,
    section,
    palletHeader,
    section,
    ...palletLines,
  ];
}


async function generateShipmentDocuments(context) {
  const syncedContext = await syncShipmentAggregateData(context.shipment.shipmentID);
  const folder = await ensureShipmentFolder(syncedContext.shipment);
  const ref = formatShipmentRef(syncedContext.shipment.shipmentID);
  const summaryName = `${ref}.pdf`;
  const summaryPath = path.join(folder.shipmentPath, summaryName);
  await fsp.writeFile(summaryPath, createShipmentPackingListPdfBuffer(syncedContext));
  return { shipmentRef: ref, folderPath: folder.shipmentPath, files: [{ fileName: summaryName, filePath: summaryPath, deliveryID: null }] };
}


function buildCollectionEmailBody(shipment) {
  const ref = formatShipmentRef(shipment.shipmentID);
  return ['Hi,', '', 'The following reference is ready to collect from Kongsberg.', '', `Ref: ${ref}`, '', 'Invoice & packing list attached.', '', 'Please arrange collection.', 'Open Monday - Thursday, 08:00 - 16:00', 'Open Friday, 08:00 - 12:00', '', 'Collection Address:', '', 'Kongsberg Automotive', 'Euroflex Centre', 'Foxbridge Way', 'Normanton', 'WF6 1TN, West Yorkshire', '', 'Best Regards', 'Kongsberg Automotive', 'Logistics Department'].join('\r\n');
}


function splitBase64Lines(value) { return value.replace(/(.{76})/g, '$1\r\n'); }

function buildMimeMessage({ from, to, cc, subject, textBody, attachments }) {
  const boundary = `----PortalShipment${Date.now()}`;
  const parts = [`From: ${from}`, `To: ${to.join(', ')}`, ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []), `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, 'Content-Type: text/plain; charset="utf-8"', 'Content-Transfer-Encoding: 8bit', '', textBody];
  for (const attachment of attachments) 
    parts.push('', `--${boundary}`, `Content-Type: application/pdf; name="${attachment.fileName}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${attachment.fileName}"`, '', splitBase64Lines(attachment.content.toString('base64')));
  parts.push('', `--${boundary}--`, '');
  return parts.join('\r\n');
}


async function sendSmtpMessage({ from, to, cc, bcc, message }) {
  const settings = getLogisticsSettings();
  if (!settings.smtpHost || !settings.mailFrom) { 
    const err = new Error('Logistics email is not configured. Set SMTP host and from address in env or config.'); 
    err.statusCode = 503; 
    throw err; }

  const recipients = [...to, ...cc, ...bcc].filter(Boolean);
  if (!recipients.length) { 
    const err = new Error('No email recipients were provided.'); 
    err.statusCode = 400; 
    throw err; }

  const createSocket = () => settings.smtpSecure
    ? tls.connect({
        host: settings.smtpHost,
        port: settings.smtpPort,
        rejectUnauthorized: !settings.smtpAllowInvalidCert,
      })
    : net.createConnection({ host: settings.smtpHost, port: settings.smtpPort });

  const socket = createSocket();
  socket.setEncoding('utf8');
  socket.setTimeout(settings.smtpConnectionTimeoutMs);
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('connect', handleConnect);
      socket.off('secureConnect', handleSecureConnect);
      socket.off('error', handleError);
      socket.off('timeout', handleTimeout);
    };
    const handleConnect = () => {
      if (!settings.smtpSecure) {
        cleanup();
        resolve();
      }
    };
    const handleSecureConnect = () => {
      cleanup();
      resolve();
    };
    const handleError = err => {
      cleanup();
      reject(err);
    };
    const handleTimeout = () => {
      cleanup();
      reject(new Error(`SMTP connection to ${settings.smtpHost}:${settings.smtpPort} timed out.`));
    };

    socket.once('connect', handleConnect);
    socket.once('secureConnect', handleSecureConnect);
    socket.once('error', handleError);
    socket.once('timeout', handleTimeout);
  });
  const pending = []; const queued = []; 
  let buffer = ''; let chunkLines = [];

  socket.on('data', data => {
    buffer += data; let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex + 1).trimEnd();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) { 
        chunkLines.push(line); 
        if (/^\d{3} /.test(line)) { 
          const response = chunkLines.join('\n'); 
          chunkLines = []; 
          const next = pending.shift(); 
          if (next) 
            next.resolve(response); 
          else 
            queued.push(response); } }
      newlineIndex = buffer.indexOf('\n');
    }
  });
  socket.on('error', err => { while (pending.length) pending.shift().reject(err); });
  socket.on('timeout', () => {
    while (pending.length) pending.shift().reject(new Error(`SMTP session with ${settings.smtpHost}:${settings.smtpPort} timed out.`));
    socket.destroy();
  });
  const readResponse = () => new Promise((resolve, reject) => { if (queued.length) return resolve(queued.shift()); pending.push({ resolve, reject }); });
  const assertCode = (response, allowed) => {
    const code = Number.parseInt(response.slice(0, 3), 10);
    if (!allowed.includes(code)) throw new Error(`SMTP error ${code}: ${response}`);
  };
  const sendCommand = async (command, allowed) => { socket.write(`${command}\r\n`); const response = await readResponse(); assertCode(response, allowed); return response; };
  const sendEhlo = async () => {
    try {
      await sendCommand(`EHLO ${settings.smtpHelloName}`, [250]);
    } catch (err) {
      await sendCommand(`HELO ${settings.smtpHelloName}`, [250]);
      return err;
    }
    return null;
  };

  try {
    assertCode(await readResponse(), [220]);
    const ehloError = await sendEhlo();
    if (settings.smtpUser) {
      try {
        await sendCommand('AUTH LOGIN', [334]);
        await sendCommand(Buffer.from(settings.smtpUser).toString('base64'), [334]);
        await sendCommand(Buffer.from(settings.smtpPass || '').toString('base64'), [235]);
      } catch (err) {
        err.message = `SMTP authentication failed for ${settings.smtpHost}:${settings.smtpPort}. ${err.message}`;
        throw err;
      }
    } else if (ehloError && settings.smtpSecure) {
      ehloError.message = `SMTP server ${settings.smtpHost}:${settings.smtpPort} rejected EHLO during secure relay setup. ${ehloError.message}`;
      throw ehloError;
    }
    await sendCommand(`MAIL FROM:<${from}>`, [250]);
    for (const recipient of recipients) await sendCommand(`RCPT TO:<${recipient}>`, [250, 251]);
    await sendCommand('DATA', [354]);
    socket.write(`${message}\r\n.\r\n`);
    assertCode(await readResponse(), [250]);
    await sendCommand('QUIT', [221]);
  } catch (err) {
    err.statusCode = err.statusCode || 502;
    throw err;
  } finally {
    socket.end();
  }
}


router.get('/', async (req, res) => {
  try { 
    const pool = await getPool(); 
    const result = await pool.request().query('SELECT * FROM Logistics.dbo.ShipmentMain'); 
    res.json(result.recordset); }
  catch (err) { res.status(500).json({ error: err.message }); }
});


// â”€â”€ Shipment queues â”€â”€
router.get('/queue/:mode', async (req, res) => {
  try {
    const settings = getLogisticsSettings();
    const pool = await getPool();
    const request = pool.request();
    const whereClause = buildShipmentQueueFilter(req.params.mode, request, settings);
    const result = await request.query(`
      SELECT DISTINCT
        sm.*,
        fa.forwarderName,
        CAST(ISNULL(sm.collectionStatus, 0) AS bit) AS collectionStatus,
        CAST(ISNULL(sm.deliveryStatus, 0) AS bit) AS deliveryStatus,
        CASE WHEN ISNULL(sm.plannedDelivery, '1900-01-01') > '1900-01-01' THEN sm.plannedDelivery ELSE sm.plannedCollection END AS plannedMovement
      FROM Logistics.dbo.ShipmentMain sm
      OUTER APPLY (
        SELECT TOP 1 f.forwarderName
        FROM Logistics.dbo.Forwarders f
        WHERE f.forwarderID = sm.forwarderID
      ) fa
      WHERE ${whereClause}
      ORDER BY
        CASE WHEN ISNULL(sm.plannedDelivery, '1900-01-01') > '1900-01-01' THEN sm.plannedDelivery ELSE sm.plannedCollection END ASC,
        sm.shipmentID ASC`);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});


// â”€â”€ Bulk mark collected â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/mark-collected-bulk', requirePermission('LOG_PLANNING'), async (req, res) => {
  const shipmentIds = normalizeIdList(req.body.shipmentIDs);
  if (!shipmentIds.length) return res.status(400).json({ success: false, error: 'No shipments selected.' });

  const pool = await getPool();
  const completed = [];
  const failed    = [];

  for (const shipmentId of shipmentIds) {
    try {
      const result = await pool.request()
        .input('shipmentId', sql.BigInt, shipmentId)
        .query(`
          UPDATE Logistics.dbo.ShipmentMain
          SET collectionStatus = 1, actualCollection = GETDATE()
          WHERE shipmentID = @shipmentId
            AND ISNULL(shipmentCancelled, 0) = 0
            AND ISNULL(collectionStatus, 0) = 0;
          SELECT @@ROWCOUNT AS affectedRows;
        `);
      if (!result.recordset[0]?.affectedRows) throw new Error('Already collected or not found.');
      const username  = req.session?.user?.username || 'unknown';
      const eventDesc = [String(req.body.description || ''), `confirmed by ${username}`].filter(Boolean).join(' | ');
      await writeShipmentEvent(pool, shipmentId, 'COLLECTED', eventDesc);
      completed.push(shipmentId);
    } catch (err) {
      failed.push({ shipmentID: shipmentId, error: err.message });
    }
  }

  if (!completed.length) return res.status(409).json({ success: false, error: 'No shipments were updated.', data: { completed, failed } });
  res.json({ success: true, data: { completed, failed } });
});


// â”€â”€ Loading list PDF (streams directly to browser) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/loading-list', async (req, res) => {
  const shipmentIds = normalizeIdList(req.body.shipmentIDs);
  if (!shipmentIds.length) return res.status(400).json({ success: false, error: 'No shipments selected.' });

  const pool = await getPool();
  const shipmentsData = [];

  for (const shipmentId of shipmentIds) {
    const shipResult = await pool.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .query(`
        SELECT sm.*, fa.forwarderName
        FROM Logistics.dbo.ShipmentMain sm
        OUTER APPLY (SELECT TOP 1 f.forwarderName FROM Logistics.dbo.Forwarders f WHERE f.forwarderID = sm.forwarderID) fa
        WHERE sm.shipmentID = @shipmentId AND ISNULL(sm.shipmentCancelled, 0) = 0`);
    if (!shipResult.recordset.length) continue;

    const palletResult = await pool.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .query(`
        SELECT pm.palletID, pm.palletType, pm.palletLocation,
          CAST(ISNULL(pm.grossWeight, 0) AS decimal(18,3)) AS grossWeight,
          pm.palletLength, pm.palletWidth, pm.palletHeight
        FROM Logistics.dbo.ShipmentLink sl
        INNER JOIN Logistics.dbo.DeliveryLink dl ON dl.deliveryID = sl.deliveryID
        INNER JOIN Logistics.dbo.PalletMain   pm ON pm.palletID   = dl.palletID
        WHERE sl.shipmentID = @shipmentId AND ISNULL(pm.palletRemoved, 0) = 0
        ORDER BY pm.palletLocation ASC, pm.palletID ASC`);

    shipmentsData.push({ shipment: shipResult.recordset[0], pallets: palletResult.recordset });
  }

  if (!shipmentsData.length) return res.status(404).json({ success: false, error: 'No valid shipments found.' });

  const pdfBuffer = createLoadingListPdfBuffer(shipmentsData);
  const filename  = `loading-list-${new Date().toISOString().slice(0, 10)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', pdfBuffer.length);
  res.end(pdfBuffer);
});


// â”€â”€ Update planned collection date for multiple shipments â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/update-planned-collection', requirePermission('LOG_PLANNING'), async (req, res) => {
  const shipmentIds = normalizeIdList(req.body.shipmentIDs);
  const date        = req.body.date;
  if (!shipmentIds.length) return res.status(400).json({ success: false, error: 'No shipments selected.' });
  if (!date) return res.status(400).json({ success: false, error: 'Date is required.' });

  const parsed = new Date(date);
  if (isNaN(parsed.getTime())) return res.status(400).json({ success: false, error: 'Invalid date.' });

  const pool = await getPool();
  const request = pool.request();
  const inClause = createInClause(request, shipmentIds, 'sid');
  request.input('date', sql.DateTime, parsed);
  await request.query(`
    UPDATE Logistics.dbo.ShipmentMain SET plannedCollection = @date
    WHERE shipmentID IN (${inClause}) AND ISNULL(shipmentCancelled, 0) = 0`);
  stampDbChange(req.session?.user?.username, 'ShipmentMain');
  res.json({ success: true });
});


// â”€â”€ Write ShipmentEvents entries â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/events', async (req, res) => {
  const events = req.body.events;
  if (!Array.isArray(events) || !events.length) return res.status(400).json({ success: false, error: 'events array required.' });

  const pool = await getPool();
  for (const { shipmentID, category, description } of events) {
    if (!shipmentID || !category || !description) continue;
    await writeShipmentEvent(pool, Number(shipmentID), String(category), String(description));
  }
  res.json({ success: true });
});


router.post('/cancel', requirePermission('LOG_PLANNING'), async (req, res) => {
  const shipmentIds = normalizeIdList(req.body.shipmentIDs);
  if (!shipmentIds.length) {
    return res.status(400).json({ success: false, error: 'Select at least one shipment before cancelling.' });
  }

  let tx = null;
  try {
    const pool = await getPool();
    tx = new sql.Transaction(pool);
    await tx.begin();

    const deleteRequest = tx.request();
    const deleteClause = createInClause(deleteRequest, shipmentIds, 'deleteShipmentId');
    await deleteRequest.query(`
      DELETE FROM Logistics.dbo.ShipmentLink
      WHERE shipmentID IN (${deleteClause})
    `);

    const updateRequest = tx.request();
    const updateClause = createInClause(updateRequest, shipmentIds, 'updateShipmentId');
    const result = await updateRequest.query(`
      UPDATE Logistics.dbo.ShipmentMain
      SET shipmentCancelled = 1
      WHERE shipmentID IN (${updateClause})
        AND ISNULL(shipmentCancelled, 0) = 0;

      SELECT @@ROWCOUNT AS affectedRows;
    `);

    await tx.commit();
    res.json({ success: true, data: { updated: Number(result.recordset[0]?.affectedRows || 0) } });
  } catch (err) {
    try { if (tx) await tx.rollback(); } catch (_) {}
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});


router.post('/:shipmentId/mark-collected', requirePermission('LOG_PLANNING'), async (req, res) => {
  try {
    const pool = await getPool();
    const shipmentId = Number(req.params.shipmentId);
    const result = await pool.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .query(`
        UPDATE Logistics.dbo.ShipmentMain
        SET collectionStatus = 1, actualCollection = GETDATE()
        WHERE shipmentID = @shipmentId
          AND ISNULL(shipmentCancelled, 0) = 0
          AND ISNULL(collectionStatus, 0) = 0;
        SELECT @@ROWCOUNT AS affectedRows;
      `);

    if (!result.recordset[0]?.affectedRows) {
      const err = new Error('Shipment could not be marked as collected.');
      err.statusCode = 409;
      throw err;
    }
    const username = req.session?.user?.username || 'unknown';
    await writeShipmentEvent(pool, shipmentId, 'COLLECTED', `Shipment marked as collected by ${username}`);
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});


router.post('/:shipmentId/mark-delivered', requirePermission('LOG_PLANNING'), async (req, res) => {
  try {
    const pool         = await getPool();
    const shipmentId   = Number(req.params.shipmentId);
    const actualDelivery = req.body.actualDelivery ? new Date(req.body.actualDelivery) : new Date();
    const result = await pool.request()
      .input('shipmentId',    sql.BigInt,   shipmentId)
      .input('actualDelivery', sql.DateTime, actualDelivery)
      .query(`
        UPDATE Logistics.dbo.ShipmentMain
        SET deliveryStatus = 1, actualDelivery = COALESCE(@actualDelivery, GETDATE())
        WHERE shipmentID = @shipmentId
          AND ISNULL(shipmentCancelled, 0) = 0
          AND ISNULL(collectionStatus,  0) = 1
          AND ISNULL(deliveryStatus,    0) = 0;
        SELECT @@ROWCOUNT AS affectedRows;
      `);

    if (!result.recordset[0]?.affectedRows) {
      const err = new Error('Shipment could not be marked as delivered.');
      err.statusCode = 409;
      throw err;
    }

    const username = req.session?.user?.username || 'unknown';
    await writeShipmentEvent(pool, shipmentId, 'DELIVERED',
      `Delivered on ${actualDelivery.toLocaleDateString('en-GB')} - confirmed by ${username}`);
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});


router.post('/mark-booked', requirePermission('LOG_PLANNING'), async (req, res) => {
  const shipmentUpdates = normalizeShipmentUpdates(req.body.shipments);
  const shipmentIds = shipmentUpdates.length ? shipmentUpdates.map(item => item.shipmentID) : normalizeIdList(req.body.shipmentIDs);
  if (!shipmentIds.length) {
    return res.status(400).json({ success: false, error: 'Select at least one shipment before confirming booking.' });
  }

  let tx = null;
  try {
    const pool = await getPool();
    tx = new sql.Transaction(pool);
    await tx.begin();
    let updated = 0;

    if (shipmentUpdates.length) {
      for (const item of shipmentUpdates) {
        const result = await tx.request()
          .input('shipmentId', sql.BigInt, item.shipmentID)
          .input('trackingNumber',   sql.NVarChar, item.trackingNumber || null)
          .input('plannedCollection', sql.DateTime, item.plannedCollection || null)
          .input('plannedDelivery',   sql.DateTime, item.plannedDelivery  ? new Date(item.plannedDelivery) : null)
          .input('forwarderID', sql.BigInt, Number.isFinite(item.forwarderID) ? item.forwarderID : null)
          .query(`
            UPDATE Logistics.dbo.ShipmentMain
            SET
              bookingStatus     = 1,
              trackingNumber    = COALESCE(NULLIF(@trackingNumber, ''), trackingNumber),
              plannedCollection = COALESCE(@plannedCollection, plannedCollection),
              plannedDelivery   = COALESCE(@plannedDelivery,   plannedDelivery),
              forwarderID       = COALESCE(@forwarderID, forwarderID)
            WHERE shipmentID = @shipmentId
              AND ISNULL(shipmentCancelled, 0) = 0
              AND ISNULL(bookingStatus, 0) = 0;

            SELECT @@ROWCOUNT AS affectedRows;
          `);
        updated += Number(result.recordset[0]?.affectedRows || 0);
      }
    } else {
      const request = tx.request();
      const inClause = createInClause(request, shipmentIds, 'shipmentId');
      const result = await request.query(`
        UPDATE Logistics.dbo.ShipmentMain
        SET bookingStatus = 1
        WHERE shipmentID IN (${inClause})
          AND ISNULL(shipmentCancelled, 0) = 0
          AND ISNULL(bookingStatus, 0) = 0;

        SELECT @@ROWCOUNT AS affectedRows;
      `);
      updated = Number(result.recordset[0]?.affectedRows || 0);
    }

    await tx.commit();
    res.json({ success: true, data: { updated } });
  } catch (err) {
    try { if (tx) await tx.rollback(); } catch (_) {}
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});


router.post('/create-from-deliveries', requirePermission('LOG_PLANNING'), async (req, res) => {
  const deliveryIDs = normalizeDeliveryIds(req.body.deliveryIDs);
  if (!deliveryIDs.length) 
    return res.status(400).json({ success: false, error: 'Select at least one delivery before creating a shipment.' });

  const pool = await getPool(); const tx = new sql.Transaction(pool);
  try {
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    const request = tx.request(); 
    const inClause = createInClause(request, deliveryIDs, 'deliveryId');

    const deliveriesResult = await request.query(`
      SELECT dm.deliveryID, dm.customerID, dm.dueDate, dm.completionDate, dm.deliveryService, dm.picksheetComment, dm.incoterms,
        CAST(ISNULL(dm.netWeight, 0) AS decimal(18,3)) AS netWeight, CAST(ISNULL(dm.grossWeight, 0) AS decimal(18,3)) AS grossWeight,
        CAST(ISNULL(dm.palletCount, 0) AS decimal(18,3)) AS palletCount, CAST(ISNULL(dm.deliveryVolume, 0) AS decimal(18,3)) AS deliveryVolume,
        d.destinationName, d.destinationStreet, d.destinationCity, d.destinationPostCode, d.destinationCountry, d.defaultIncoterms,
        STUFF((
          SELECT '; ' + e.address
          FROM Logistics.dbo.Email e
          WHERE e.ID = dm.customerID
          FOR XML PATH('')
        ), 1, 2, '') AS destinationEmail
      FROM Logistics.dbo.DeliveryMain dm 
        LEFT JOIN Logistics.dbo.Destinations d ON d.destinationID = dm.customerID 
        LEFT JOIN Logistics.dbo.ShipmentLink sl ON sl.deliveryID = dm.deliveryID 
      WHERE dm.deliveryID IN (${inClause}) AND dm.completionStatus = 1 
        AND ISNULL(dm.deliveryCancelled, 0) = 0 
        AND sl.deliveryID IS NULL 
      ORDER BY dm.deliveryID ASC`);

    const deliveries = deliveriesResult.recordset;
    if (deliveries.length !== deliveryIDs.length) 
      throw new Error('One or more deliveries are no longer available for shipment creation. Please refresh and try again.');

    const customerIds = [...new Set(deliveries.map(row => String(row.customerID)))];
    if (customerIds.length !== 1)
      throw new Error('Selected deliveries must all belong to the same customer.');

    // Enforce incoterms consistency â€” delivery-level incoterms take priority over destination default
    const effectiveIncoterms = deliveries.map(row =>
      String(row.incoterms || row.defaultIncoterms || '').trim().toUpperCase()
    );
    const uniqueIncoterms = [...new Set(effectiveIncoterms.filter(Boolean))];
    if (uniqueIncoterms.length > 1) {
      const detail = deliveries.map(row =>
        `#${row.deliveryID} â†’ ${String(row.incoterms || row.defaultIncoterms || '?').toUpperCase()}`
      ).join(', ');
      const err = new Error(`Deliveries have conflicting incoterms (${uniqueIncoterms.join(' vs ')}): ${detail}. All deliveries in a shipment must share the same incoterms.`);
      err.statusCode = 400;
      throw err;
    }

    const first = deliveries[0];
    const settings = getLogisticsSettings();
    const totals = deliveries.reduce((acc, row) => { acc.netWeight += toDecimal(row.netWeight); acc.grossWeight += toDecimal(row.grossWeight); acc.palletCount += toDecimal(row.palletCount); acc.shipmentVolume += toDecimal(row.deliveryVolume); return acc; }, { netWeight: 0, grossWeight: 0, palletCount: 0, shipmentVolume: 0 });
    const shipmentDraft = {
      destinationID: first.customerID,
      destinationName: String(req.body.destinationName || first.destinationName || '').trim(),
      destinationStreet: String(req.body.destinationStreet || first.destinationStreet || '').trim(),
      destinationCity: String(req.body.destinationCity || first.destinationCity || '').trim(),
      destinationPostCode: String(req.body.destinationPostCode || first.destinationPostCode || '').trim(),
      destinationCountry: String(req.body.destinationCountry || first.destinationCountry || '').trim(),
      plannedCollection: req.body.plannedCollection ? new Date(req.body.plannedCollection) : null,
      actualCollection: req.body.actualCollection ? new Date(req.body.actualCollection) : null,
      collectionStatus: toBool(req.body.collectionStatus),
      forwarderID: toNullableInteger(req.body.forwarderID),
      trackingNumber: String(req.body.trackingNumber || '').trim(),
      incoTerms: String(req.body.incoTerms || effectiveIncoterms[0] || '').trim(),
      customsRequired: toBool(req.body.customsRequired),
      customsComplete: toBool(req.body.customsComplete),
      shipmentCancelled: toBool(req.body.shipmentCancelled),
    };
    const insertResult = await tx.request().input('originID', sql.BigInt, settings.originID).input('originName', sql.NVarChar, settings.originName).input('originStreet', sql.NVarChar, settings.originStreet).input('originCity', sql.NVarChar, settings.originCity).input('originPostCode', sql.NVarChar, settings.originPostCode).input('originCountry', sql.NVarChar, settings.originCountry).input('destinationID', sql.BigInt, shipmentDraft.destinationID).input('destinationName', sql.NVarChar, shipmentDraft.destinationName).input('destinationStreet', sql.NVarChar, shipmentDraft.destinationStreet).input('destinationCity', sql.NVarChar, shipmentDraft.destinationCity).input('destinationPostCode', sql.NVarChar, shipmentDraft.destinationPostCode).input('destinationCountry', sql.NVarChar, shipmentDraft.destinationCountry).input('netWeight', sql.Decimal(18, 3), totals.netWeight).input('grossWeight', sql.Decimal(18, 3), totals.grossWeight).input('palletCount', sql.Decimal(18, 3), totals.palletCount).input('shipmentVolume', sql.Decimal(18, 3), totals.shipmentVolume).input('plannedCollection', sql.DateTime, shipmentDraft.plannedCollection).input('actualCollection', sql.DateTime, shipmentDraft.actualCollection).input('collectionStatus', sql.Bit, shipmentDraft.collectionStatus).input('forwarderID', sql.BigInt, shipmentDraft.forwarderID).input('trackingNumber', sql.NVarChar, shipmentDraft.trackingNumber || null).input('incoTerms', sql.NVarChar, shipmentDraft.incoTerms || null).input('customsRequired', sql.Bit, shipmentDraft.customsRequired).input('customsComplete', sql.Bit, shipmentDraft.customsComplete).input('shipmentCancelled', sql.Bit, shipmentDraft.shipmentCancelled).query(`INSERT INTO Logistics.dbo.ShipmentMain (originID, originName, originStreet, originCity, originPostCode, originCountry, destinationID, destinationName, destinationStreet, destinationCity, destinationPostCode, destinationCountry, netWeight, grossWeight, palletCount, shipmentVolume, plannedCollection, actualCollection, collectionStatus, forwarderID, trackingNumber, incoTerms, customsRequired, customsComplete, shipmentCancelled) VALUES (@originID, @originName, @originStreet, @originCity, @originPostCode, @originCountry, @destinationID, @destinationName, @destinationStreet, @destinationCity, @destinationPostCode, @destinationCountry, @netWeight, @grossWeight, @palletCount, @shipmentVolume, @plannedCollection, @actualCollection, @collectionStatus, @forwarderID, @trackingNumber, @incoTerms, @customsRequired, @customsComplete, @shipmentCancelled); SELECT SCOPE_IDENTITY() AS shipmentID;`);
    const shipmentID = Number(insertResult.recordset[0].shipmentID);
    
    for (const deliveryID of deliveryIDs) 
      await tx.request().input('shipmentID', sql.BigInt, shipmentID).input('deliveryID', sql.BigInt, deliveryID).query('INSERT INTO Logistics.dbo.ShipmentLink (shipmentID, deliveryID) VALUES (@shipmentID, @deliveryID)');
    
    await tx.commit();
    const username = req.session?.user?.username || 'unknown';
    stampDbChange(username, 'ShipmentMain');
    await writeShipmentEvent(pool, shipmentID, 'CREATED',
      `Shipment created by ${username} from ${deliveryIDs.length} deliver${deliveryIDs.length !== 1 ? 'ies' : 'y'}: ${deliveryIDs.join(', ')}`);
    const shipment = await getShipmentById(pool, shipmentID);
    const folder = getShipmentFolderInfo(shipment);
    return res.status(201).json({ success: true, data: { shipmentID, shipmentRef: formatShipmentRef(shipmentID), linkedDeliveries: deliveryIDs.length, canSendEmail: isExWorks(shipment.incoTerms), folderPath: folder.shipmentPath, shipment } });
  } catch (err) {
    try { if (tx._aborted !== true) await tx.rollback(); } catch (_) {}
    return res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});


router.post('/:shipmentId/create-folder', async (req, res) => {
  try { const context = await getShipmentContext(req.params.shipmentId); 
        const folder = await ensureShipmentFolder(context.shipment); 
        res.json({ success: true, data: { 
          shipmentRef: folder.shipmentRef, folderPath: folder.shipmentPath 
        } }); }
  catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
});


router.post('/:shipmentId/generate-packing-list', requirePermission('LOG_PLANNING'), async (req, res) => {
  try {
    const context = await getShipmentContext(req.params.shipmentId); 
    const generated = await generateShipmentDocuments(context);
    res.json({ success: true, data: { 
      shipmentRef: generated.shipmentRef, folderPath: generated.folderPath, 
      files: generated.files.map(file => ({ 
        fileName: file.fileName, deliveryID: file.deliveryID, 
        downloadUrl: `/api/shipmentmain/${req.params.shipmentId}/documents/${encodeURIComponent(file.fileName)}` 
      })) 
    } });
  } catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
});


router.get('/:shipmentId/documents/:fileName', async (req, res) => {
  try {
    const context = await getShipmentContext(req.params.shipmentId); 
    const folder = getShipmentFolderInfo(context.shipment); 
    const fileName = path.basename(req.params.fileName || '');
    if (!fileName.toLowerCase().endsWith('.pdf')) 
      return res.status(400).json({ success: false, error: 'Only PDF documents are available.' });

    const target = path.join(folder.shipmentPath, fileName); 
    await fsp.access(target, fs.constants.F_OK); 
    return res.sendFile(target);
  } catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
});


router.post('/:shipmentId/send-collection-email', requirePermission('LOG_PLANNING'), async (req, res) => {
  try {
    const context = await getShipmentContext(req.params.shipmentId);
    if (!isExWorks(context.shipment.incoTerms)) 
      return res.status(400).json({ success: false, error: 'Collection email is only available for Ex Works shipments.' });
    
    const destinationEmail = String(context.deliveries[0]?.destinationEmail || '').trim();
    if (!destinationEmail) 
      return res.status(400).json({ success: false, error: 'Destination email is missing for this shipment.' });
    
    const generated = await generateShipmentDocuments(context); const settings = getLogisticsSettings();
    const attachments = await Promise.all(generated.files.map(async file => ({ fileName: file.fileName, content: await fsp.readFile(file.filePath) })));
    const subject = `Kongsberg Automotive // Collection Ref: ${generated.shipmentRef} // ${context.shipment.destinationName || ''}`;
    const message = buildMimeMessage({ from: settings.mailFrom, to: [destinationEmail], cc: settings.mailCc, subject, textBody: buildCollectionEmailBody(context.shipment), attachments });
    
    await sendSmtpMessage({ from: settings.mailFrom, to: [destinationEmail], cc: settings.mailCc, bcc: settings.mailBcc, message });
    res.json({ success: true, data: { shipmentRef: generated.shipmentRef, sentTo: destinationEmail, cc: settings.mailCc, bcc: settings.mailBcc, attachments: generated.files.map(file => file.fileName) } });
  } catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
});


router.post('/customs/create', requirePermission('LOG_PLANNING'), async (req, res) => {
  const shipmentIds = normalizeIdList(req.body.shipmentIDs);
  if (!shipmentIds.length) {
    return res.status(400).json({ success: false, error: 'Select at least one shipment before creating customs entries.' });
  }

  const completed = [];
  const failed = [];

  for (const shipmentId of shipmentIds) {
    try {
      const context = await syncShipmentAggregateData(shipmentId);
      const { shipment } = context;
      if (toBool(shipment.shipmentCancelled)) throw new Error('Shipment is cancelled.');
      if (!toBool(shipment.customsRequired)) throw new Error('Shipment is not marked as customs required.');
      if (toBool(shipment.customsComplete)) throw new Error('Customs documents are already complete for this shipment.');

      let correlationId = String(shipment.customsID || '').trim();
      if (!correlationId) {
        const sapData = await fetchSapCustomsData(context.deliveries, req);
        const payload = buildClearPortShipmentPayload(context, sapData);
        const created = await createClearPortExport(payload);
        correlationId = created.correlationId;
      }

      const pdfBuffer = await downloadClearPortPdf(correlationId);
      const folder = await ensureShipmentFolder(shipment);
      const fileName = `${formatShipmentRef(shipment.shipmentID)}-customs-${sanitizeFileSegment(correlationId)}.pdf`;
      const filePath = path.join(folder.shipmentPath, fileName);
      await fsp.writeFile(filePath, pdfBuffer);

      await (await getPool()).request()
        .input('shipmentId', sql.BigInt, shipment.shipmentID)
        .input('customsId', sql.NVarChar, correlationId)
        .query(`
          UPDATE Logistics.dbo.ShipmentMain
          SET
            customsID = @customsId,
            customsComplete = 1
          WHERE shipmentID = @shipmentId
            AND ISNULL(shipmentCancelled, 0) = 0
            AND ISNULL(customsRequired, 0) = 1;
        `);
      stampDbChange(req.session?.user?.username, 'ShipmentMain');

      completed.push({
        shipmentID: shipment.shipmentID,
        shipmentRef: formatShipmentRef(shipment.shipmentID),
        customsID: correlationId,
        fileName,
        downloadUrl: `/api/shipmentmain/${shipment.shipmentID}/documents/${encodeURIComponent(fileName)}`,
      });
    } catch (err) {
      failed.push({
        shipmentID: shipmentId,
        shipmentRef: formatShipmentRef(shipmentId),
        error: err.message,
      });
    }
  }

  if (!completed.length) {
    return res.status(502).json({
      success: false,
      error: 'No customs entries were completed.',
      data: { completed, failed },
    });
  }

  return res.json({
    success: true,
    data: {
      completed,
      failed,
      updated: completed.length,
    },
  });
});


// â”€â”€ Shipment detail (standard modal) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/:shipmentId/details', async (req, res) => {
  try {
    const pool = await getPool();
    const shipmentId = Number(req.params.shipmentId);

    const shipmentResult = await pool.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .query(`
        SELECT sm.*,
          sm.PlannedDelivery   AS plannedDelivery,
          sm.ActualDelivery    AS actualDelivery,
          CAST(ISNULL(sm.bookingStatus,    0) AS bit) AS bookingStatus,
          CAST(ISNULL(sm.collectionStatus, 0) AS bit) AS collectionStatus,
          CAST(ISNULL(sm.deliveryStatus,   0) AS bit) AS deliveryStatus,
          CAST(ISNULL(sm.customsRequired,  0) AS bit) AS customsRequired,
          CAST(ISNULL(sm.customsComplete,  0) AS bit) AS customsComplete,
          fa.forwarderName
        FROM Logistics.dbo.ShipmentMain sm
        OUTER APPLY (
          SELECT TOP 1 f.forwarderName FROM Logistics.dbo.Forwarders f WHERE f.forwarderID = sm.forwarderID
        ) fa
        WHERE sm.shipmentID = @shipmentId`);

    if (!shipmentResult.recordset.length)
      return res.status(404).json({ success: false, error: 'Shipment not found.' });

    const deliveriesResult = await pool.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .query(`
        SELECT
          dm.deliveryID, dm.customerID, dm.deliveryService, dm.picksheetComment,
          CAST(ISNULL(dm.netWeight,      0) AS decimal(18,3)) AS netWeight,
          CAST(ISNULL(dm.grossWeight,    0) AS decimal(18,3)) AS grossWeight,
          CAST(ISNULL(dm.palletCount,    0) AS decimal(18,3)) AS palletCount,
          CAST(ISNULL(dm.deliveryVolume, 0) AS decimal(18,3)) AS deliveryVolume,
          d.destinationName
        FROM Logistics.dbo.ShipmentLink sl
        INNER JOIN Logistics.dbo.DeliveryMain dm ON dm.deliveryID = sl.deliveryID
        LEFT  JOIN Logistics.dbo.Destinations d  ON d.destinationID = dm.customerID
        WHERE sl.shipmentID = @shipmentId
        ORDER BY dm.deliveryID ASC`);

    res.json({ success: true, data: { shipment: shipmentResult.recordset[0], deliveries: deliveriesResult.recordset } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});


// â”€â”€ Toggle customsRequired (blocked if customsComplete) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.patch('/:shipmentId/customs-required', requirePermission('LOG_PLANNING'), async (req, res) => {
  try {
    const pool = await getPool();
    const shipmentId = Number(req.params.shipmentId);

    const check = await pool.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .query('SELECT customsComplete FROM Logistics.dbo.ShipmentMain WHERE shipmentID = @shipmentId');

    if (!check.recordset.length)
      return res.status(404).json({ success: false, error: 'Shipment not found.' });
    if (toBool(check.recordset[0].customsComplete))
      return res.status(400).json({ success: false, error: 'Customs is already complete and cannot be changed.' });

    await pool.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .input('required', sql.Bit, toBool(req.body.required) ? 1 : 0)
      .query(`UPDATE Logistics.dbo.ShipmentMain SET customsRequired = @required
              WHERE shipmentID = @shipmentId AND ISNULL(customsComplete, 0) = 0`);
    stampDbChange(req.session?.user?.username, 'ShipmentMain');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});


// â”€â”€ Remove a delivery from a shipment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.delete('/:shipmentId/deliveries/:deliveryId', requirePermission('LOG_PLANNING'), async (req, res) => {
  try {
    const pool = await getPool();
    const shipmentId = Number(req.params.shipmentId);
    const deliveryId = Number(req.params.deliveryId);

    await pool.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .input('deliveryId', sql.BigInt, deliveryId)
      .query('DELETE FROM Logistics.dbo.ShipmentLink WHERE shipmentID = @shipmentId AND deliveryID = @deliveryId');

    const remaining = await pool.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .query('SELECT COUNT(*) AS cnt FROM Logistics.dbo.ShipmentLink WHERE shipmentID = @shipmentId');

    if (remaining.recordset[0].cnt === 0) {
      await pool.request()
        .input('shipmentId', sql.BigInt, shipmentId)
        .query('UPDATE Logistics.dbo.ShipmentMain SET shipmentCancelled = 1 WHERE shipmentID = @shipmentId');
      return res.json({ success: true, data: { cancelled: true } });
    }

    await syncShipmentAggregateData(shipmentId);
    res.json({ success: true, data: { cancelled: false } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});


// â”€â”€ Add deliveries to an existing shipment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/:shipmentId/deliveries', requirePermission('LOG_PLANNING'), async (req, res) => {
  try {
    const pool = await getPool();
    const shipmentId = Number(req.params.shipmentId);
    const deliveryIDs = normalizeDeliveryIds(req.body.deliveryIDs);

    if (!deliveryIDs.length)
      return res.status(400).json({ success: false, error: 'No delivery IDs provided.' });

    const shipmentResult = await pool.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .query('SELECT destinationID, incoTerms FROM Logistics.dbo.ShipmentMain WHERE shipmentID = @shipmentId AND ISNULL(shipmentCancelled, 0) = 0');

    if (!shipmentResult.recordset.length)
      return res.status(404).json({ success: false, error: 'Shipment not found or cancelled.' });

    const { destinationID: customerId, incoTerms: shipmentIncoTerms } = shipmentResult.recordset[0];

    const req2 = pool.request();
    const inClause = createInClause(req2, deliveryIDs, 'deliveryId');
    const available = await req2.query(`
      SELECT dm.deliveryID, dm.customerID, dm.incoterms, d.defaultIncoterms
      FROM Logistics.dbo.DeliveryMain dm
      LEFT JOIN Logistics.dbo.Destinations d ON d.destinationID = dm.customerID
      LEFT JOIN Logistics.dbo.ShipmentLink sl ON sl.deliveryID = dm.deliveryID
      WHERE dm.deliveryID IN (${inClause})
        AND dm.completionStatus = 1
        AND ISNULL(dm.deliveryCancelled, 0) = 0
        AND sl.deliveryID IS NULL`);

    if (available.recordset.length !== deliveryIDs.length)
      return res.status(400).json({ success: false, error: 'One or more deliveries are unavailable (already shipped, incomplete, or cancelled).' });

    const wrongCustomer = available.recordset.filter(d => String(d.customerID) !== String(customerId));
    if (wrongCustomer.length)
      return res.status(400).json({ success: false, error: 'All deliveries must belong to the same customer as the shipment.' });

    // Validate incoterms match the shipment
    const shipmentTerms = String(shipmentIncoTerms || '').trim().toUpperCase();
    if (shipmentTerms) {
      const conflicting = available.recordset.filter(d => {
        const effective = String(d.incoterms || d.defaultIncoterms || '').trim().toUpperCase();
        return effective && effective !== shipmentTerms;
      });
      if (conflicting.length) {
        const detail = conflicting.map(d =>
          `#${d.deliveryID} (${String(d.incoterms || d.defaultIncoterms || '?').toUpperCase()})`
        ).join(', ');
        return res.status(400).json({
          success: false,
          error: `Incoterms mismatch: shipment is ${shipmentTerms} but ${detail} differ. Only deliveries with matching incoterms can be added.`,
        });
      }
    }

    for (const deliveryId of deliveryIDs) {
      await pool.request()
        .input('shipmentId', sql.BigInt, shipmentId)
        .input('deliveryId', sql.BigInt, deliveryId)
        .query('INSERT INTO Logistics.dbo.ShipmentLink (shipmentID, deliveryID) VALUES (@shipmentId, @deliveryId)');
    }

    await syncShipmentAggregateData(shipmentId);
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
});


// â”€â”€ Update haulier â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ── Correct dates and status flags (admin correction) ────────────────────────
router.patch('/:shipmentId/status-dates', requirePermission('LOG_PLANNING'), async (req, res) => {
  try {
    const pool       = await getPool();
    const shipmentId = Number(req.params.shipmentId);
    const request    = pool.request().input('shipmentId', sql.BigInt, shipmentId);
    const sets       = [];

    const addDate = (key, col) => {
      const raw = req.body[key];
      if (raw === undefined) return;
      request.input(key, sql.DateTime, raw ? new Date(raw) : null);
      sets.push(`${col} = @${key}`);
    };
    const addBit = (key, col) => {
      if (req.body[key] === undefined) return;
      request.input(key, sql.Bit, req.body[key] ? 1 : 0);
      sets.push(`${col} = @${key}`);
    };

    addBit ('bookingStatus',     'bookingStatus');
    addDate('plannedCollection', 'plannedCollection');
    addBit ('collectionStatus',  'collectionStatus');
    addDate('actualCollection',  'actualCollection');
    // If marking collected but no actual date given, default to now
    if (req.body.collectionStatus && !req.body.actualCollection) {
      sets.push('actualCollection = COALESCE(actualCollection, GETDATE())');
    }
    addDate('plannedDelivery',   'plannedDelivery');
    addBit ('deliveryStatus',    'deliveryStatus');
    addDate('actualDelivery',    'actualDelivery');
    // If marking delivered but no actual date given, default to now
    if (req.body.deliveryStatus && !req.body.actualDelivery) {
      sets.push('actualDelivery = COALESCE(actualDelivery, GETDATE())');
    }

    if (!sets.length) return res.status(400).json({ success: false, error: 'Nothing to update' });

    await request.query(
      `UPDATE Logistics.dbo.ShipmentMain SET ${sets.join(', ')} WHERE shipmentID = @shipmentId`
    );

    const username = req.session?.user?.username || 'unknown';
    await writeShipmentEvent(pool, shipmentId, 'CORRECTION',
      `Dates/status corrected by ${username}: ${sets.map(s => s.split(' = ')[0]).join(', ')}`);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


router.patch('/:shipmentId/forwarder', requirePermission('LOG_PLANNING'), async (req, res) => {
  try {
    const pool = await getPool();
    const shipmentId = Number(req.params.shipmentId);
    const forwarderID = toNullableInteger(req.body.forwarderID);

    await pool.request()
      .input('shipmentId',  sql.BigInt, shipmentId)
      .input('forwarderId', sql.BigInt, forwarderID)
      .query(`UPDATE Logistics.dbo.ShipmentMain SET forwarderID = @forwarderId
              WHERE shipmentID = @shipmentId AND ISNULL(shipmentCancelled, 0) = 0`);

    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});


// â”€â”€ Shipment search â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Query params: shipmentRef, deliveryNumber, forwarder, customer,
//               dateField (plannedCollection|actualCollection|plannedDelivery|actualDelivery),
//               dateFrom, dateTo
router.get('/search', async (req, res) => {
  const { shipmentRef, deliveryNumber, forwarder, customer, dateField, dateFrom, dateTo } = req.query;

  const DATE_COLS = {
    plannedCollection: 'sm.plannedCollection',
    actualCollection:  'sm.actualCollection',
    plannedDelivery:   'sm.plannedDelivery',
    actualDelivery:    'sm.actualDelivery',
  };

  try {
    const pool    = await getPool();
    const request = pool.request();
    const where   = [`ISNULL(sm.shipmentCancelled, 0) = 0`];

    if (shipmentRef?.trim()) {
      const ref = parseInt(shipmentRef.trim(), 10);
      if (!isNaN(ref)) { request.input('shipmentRef', sql.BigInt, ref); where.push('sm.shipmentID = @shipmentRef'); }
    }
    if (customer?.trim()) {
      request.input('customer', sql.NVarChar, `%${customer.trim()}%`);
      where.push('sm.destinationName LIKE @customer');
    }
    if (forwarder?.trim()) {
      request.input('forwarder', sql.NVarChar, `%${forwarder.trim()}%`);
      where.push(`EXISTS (
        SELECT 1 FROM Logistics.dbo.Forwarders f
        WHERE f.forwarderID = sm.forwarderID AND f.forwarderName LIKE @forwarder
      )`);
    }
    if (req.query.tracking?.trim()) {
      request.input('tracking', sql.NVarChar, `%${req.query.tracking.trim()}%`);
      where.push('sm.trackingNumber LIKE @tracking');
    }
    if (deliveryNumber?.trim()) {
      const dn = parseInt(deliveryNumber.trim(), 10);
      if (!isNaN(dn)) {
        request.input('deliveryNumber', sql.BigInt, dn);
        where.push(`EXISTS (
          SELECT 1 FROM Logistics.dbo.ShipmentLink sl
          WHERE sl.shipmentID = sm.shipmentID AND sl.deliveryID = @deliveryNumber
        )`);
      }
    }
    const dateCol = DATE_COLS[dateField];
    if (dateCol) {
      if (dateFrom?.trim()) { request.input('dateFrom', sql.DateTime, new Date(dateFrom)); where.push(`${dateCol} >= @dateFrom`); }
      if (dateTo?.trim())   { request.input('dateTo',   sql.DateTime, new Date(dateTo));   where.push(`${dateCol} <= @dateTo`); }
    }

    if (where.length === 1) {
      return res.status(400).json({ success: false, error: 'Please provide at least one search term.' });
    }

    const result = await request.query(`
      SELECT sm.*,
        sm.PlannedDelivery   AS plannedDelivery,
        sm.ActualDelivery    AS actualDelivery,
        CAST(ISNULL(sm.bookingStatus,    0) AS bit) AS bookingStatus,
        CAST(ISNULL(sm.collectionStatus, 0) AS bit) AS collectionStatus,
        CAST(ISNULL(sm.deliveryStatus,   0) AS bit) AS deliveryStatus,
        (SELECT TOP 1 f.forwarderName FROM Logistics.dbo.Forwarders f WHERE f.forwarderID = sm.forwarderID) AS forwarderName
      FROM Logistics.dbo.ShipmentMain sm
      WHERE ${where.join(' AND ')}
      ORDER BY sm.shipmentID DESC`);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// â”€â”€ Events for a shipment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/:shipmentId/events', async (req, res) => {
  try {
    const pool   = await getPool();
    const result = await pool.request()
      .input('shipmentId', sql.BigInt, req.params.shipmentId)
      .query(`SELECT EventID, shipmentID, eventCategory, eventDescription, timeStamp
              FROM Logistics.dbo.ShipmentEvents
              WHERE shipmentID = @shipmentId
              ORDER BY timeStamp DESC`);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


router.get('/id/:shipmentId', async (req, res) => {
  try { 
    const pool = await getPool(); 
    const result = await pool.request().input('shipmentId', sql.BigInt, req.params.shipmentId).query('SELECT * FROM Logistics.dbo.ShipmentMain WHERE shipmentID = @shipmentId'); 
    res.json(result.recordset); }
  catch (err) { res.status(500).json({ error: err.message }); }
});


router.get('/forwarder/:forwarderId', async (req, res) => {
  try { 
    const pool = await getPool(); 
    const result = await pool.request().input('forwarderId', sql.BigInt, req.params.forwarderId).query('SELECT * FROM Logistics.dbo.ShipmentMain WHERE forwarderID = @forwarderId'); 
    res.json(result.recordset); }
  catch (err) { res.status(500).json({ error: err.message }); }
});


router.get('/destination/:destinationId', async (req, res) => {
  try { 
    const pool = await getPool(); 
    const result = await pool.request().input('destinationId', sql.BigInt, req.params.destinationId).query('SELECT * FROM Logistics.dbo.ShipmentMain WHERE destinationID = @destinationId'); 
    res.json(result.recordset); }
  catch (err) { res.status(500).json({ error: err.message }); }
});


router.get('/daterange', async (req, res) => {
  try { 
    const { dateFrom, dateTo } = req.query; 
    const pool = await getPool(); 
    const result = await pool.request().input('dateFrom', sql.DateTime, new Date(dateFrom)).input('dateTo', sql.DateTime, new Date(dateTo)).query('SELECT * FROM Logistics.dbo.ShipmentMain WHERE plannedCollection BETWEEN @dateFrom AND @dateTo'); 
    res.json(result.recordset); }
  catch (err) { res.status(500).json({ error: err.message }); }
});


router.post('/', async (req, res) => {
  try {
    const { originID, originName, originStreet, originCity, originPostCode, originCountry, destinationID, destinationName, destinationStreet, destinationCity, destinationPostCode, destinationCountry, netWeight, grossWeight, palletCount, shipmentVolume, plannedCollection, actualCollection, collectionStatus, forwarderID, trackingNumber, incoTerms, customsRequired, customsComplete, shipmentCancelled } = req.body;
    const pool = await getPool();
    const result = await pool.request().input('originID', sql.BigInt, originID).input('originName', sql.NVarChar, originName).input('originStreet', sql.NVarChar, originStreet).input('originCity', sql.NVarChar, originCity).input('originPostCode', sql.NVarChar, originPostCode).input('originCountry', sql.NVarChar, originCountry).input('destinationID', sql.BigInt, destinationID).input('destinationName', sql.NVarChar, destinationName).input('destinationStreet', sql.NVarChar, destinationStreet).input('destinationCity', sql.NVarChar, destinationCity).input('destinationPostCode', sql.NVarChar, destinationPostCode).input('destinationCountry', sql.NVarChar, destinationCountry).input('netWeight', sql.Decimal, netWeight).input('grossWeight', sql.Decimal, grossWeight).input('palletCount', sql.BigInt, palletCount).input('shipmentVolume', sql.Decimal, shipmentVolume).input('plannedCollection', sql.DateTime, plannedCollection ? new Date(plannedCollection) : null).input('actualCollection', sql.DateTime, actualCollection ? new Date(actualCollection) : null).input('collectionStatus', sql.Bit, collectionStatus).input('forwarderID', sql.BigInt, forwarderID).input('trackingNumber', sql.NVarChar, trackingNumber).input('incoTerms', sql.NVarChar, incoTerms).input('customsRequired', sql.Bit, customsRequired).input('customsComplete', sql.Bit, customsComplete).input('shipmentCancelled', sql.Bit, shipmentCancelled).query(`INSERT INTO Logistics.dbo.ShipmentMain (originID, originName, originStreet, originCity, originPostCode, originCountry, destinationID, destinationName, destinationStreet, destinationCity, destinationPostCode, destinationCountry, netWeight, grossWeight, palletCount, shipmentVolume, plannedCollection, actualCollection, collectionStatus, forwarderID, trackingNumber, incoTerms, customsRequired, customsComplete, shipmentCancelled) VALUES (@originID, @originName, @originStreet, @originCity, @originPostCode, @originCountry, @destinationID, @destinationName, @destinationStreet, @destinationCity, @destinationPostCode, @destinationCountry, @netWeight, @grossWeight, @palletCount, @shipmentVolume, @plannedCollection, @actualCollection, @collectionStatus, @forwarderID, @trackingNumber, @incoTerms, @customsRequired, @customsComplete, @shipmentCancelled); SELECT SCOPE_IDENTITY() AS shipmentID;`);
    res.status(201).json({ message: 'Record created successfully', shipmentID: result.recordset[0].shipmentID });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
