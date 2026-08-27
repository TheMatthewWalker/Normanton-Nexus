import express from 'express';
import sql from 'mssql';
import axios from 'axios';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import net from 'net';
import tls from 'tls';
import { stampDbChange, getNexusOperationsPool } from '../config.js';

import { requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { lookupModeOfTransport } from './forwardermodemapping.js';
import e from 'express';

const router = express.Router();
const getPool = getNexusOperationsPool;
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
    const cost = item?.expectedCost != null && String(item.expectedCost).trim() !== ''
      ? Number(item.expectedCost) : null;
    acc.push({
      shipmentID,
      trackingNumber:    String(item?.trackingNumber || '').trim(),
      plannedCollection: item?.plannedCollection ? new Date(item.plannedCollection) : null,
      // Bug fix: this was never mapped, so the "Planned Delivery" date typed/
      // auto-filled in the booking modal was silently discarded on submit —
      // mark-booked's UPDATE always saw item.plannedDelivery === undefined
      // and left the shipment's existing value (usually still NULL) in place.
      plannedDelivery:   item?.plannedDelivery ? new Date(item.plannedDelivery) : null,
      forwarderID:       item?.forwarderID === '' || item?.forwarderID == null ? null : Number.parseInt(String(item.forwarderID), 10),
      forwarderMode:     String(item?.forwarderMode || '').trim() || null,
      expectedCost:      Number.isFinite(cost) ? cost : null,
      costCenter:        String(item?.costCenter  || '').trim() || null,
      elementCode:       String(item?.elementCode || '').trim() || null,
      skipCost:          Boolean(item?.skipCost),
      customsCost:       item?.customsCost != null ? Number(item.customsCost) : null,
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


// Every file this app itself writes into a shipment's export folder already
// follows a fixed naming convention (generateShipmentDocuments for the
// packing list, the /customs/create route below for the ClearPort PDF), so
// most files can be pre-categorised for the operator rather than left
// blank. This is only a starting guess — the verify-documents popup always
// lets the operator confirm or override it before a KN booking can proceed.
function guessDocumentCategory(fileName, shipmentRef) {
  const lower = fileName.toLowerCase();
  if (lower === `${shipmentRef}.pdf`.toLowerCase()) return 'packing-list';
  if (lower.includes('-customs-')) return 'customs';
  if (lower.includes('-invoice-')) return 'invoice';
  return null;
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
  const { shipment, deliveries, pallets, manualCargo } = context;
  // Manual Outbound Shipments (shipment.IsManual) have no PalletMain/DeliveryLink
  // rows to pull from — their cargo lives in ManualCargoItem instead (see
  // getShipmentContext above and sql/migrate_manual_outbound_shipment.sql).
  // Everything below branches on isManual to build the packing-list table from
  // context.manualCargo rather than context.pallets for those shipments.
  const isManual = !!shipment.IsManual;
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
  const rows = isManual
    ? (manualCargo || []).map(item => ({
        cargoRef: String(item.CargoID || ''),
        description: String(item.Description || 'Cargo').slice(0, 40),
        qty: String(item.PackageCount || 1),
        dimensions: (item.Length || item.Width || item.Height) ? `${item.Length || 0} x ${item.Width || 0} x ${item.Height || 0}` : '-',
        weight: `${formatDecimal(item.Weight)} KG`,
        volume: `${formatDecimal(item.Volume || 0)} CBM`,
      }))
    : pallets.map(pallet => ({
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
    drawText(parts, 48, 602, isManual ? 'Manual Shipment - not linked to SAP deliveries' : `Linked Deliveries: ${linkedRefs}`, 10, 'F2', palette.navy);

    const cards = [
      { label: isManual ? 'Package Count' : 'Pallet Count', value: `${formatDecimal(shipment.palletCount)}` },
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
    const columns = isManual
      ? [
          ['Ref', 42],
          ['Description', 95],
          ['Qty', 305],
          ['Dimensions', 345],
          ['Weight', 440],
          ['Volume', 505],
        ]
      : [
          ['Delivery', 42],
          ['Pallet', 92],
          ['Type', 138],
          ['Dimensions', 230],
          ['Gross', 332],
          ['Net', 388],
          ['Volume', 444],
          ['Location', 500],
        ];
    columns.forEach(([label, x]) => drawText(parts, x, 507, label, 8.5, 'F2', palette.white));
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
      drawText(parts, 42, y, isManual ? 'No cargo lines recorded for this manual shipment.' : 'No pallets linked to this shipment.', 10);
      rowIndex = 1;
    } else {
      while (rowIndex < rows.length && y > 90) {
        const row = rows[rowIndex];
        if ((rowIndex % 2) === 0) drawRect(parts, 36, y - 4, 523, 18, palette.soft, true);
        if (isManual) {
          drawText(parts, 42, y, row.cargoRef, 8.5);
          drawText(parts, 95, y, row.description, 8.5);
          drawText(parts, 305, y, row.qty, 8.5);
          drawText(parts, 345, y, row.dimensions, 8.5);
          drawText(parts, 440, y, row.weight, 8.5);
          drawText(parts, 505, y, row.volume, 8.5);
        } else {
          drawText(parts, 42, y, row.deliveryID, 8.5);
          drawText(parts, 92, y, row.palletID, 8.5);
          drawText(parts, 138, y, row.palletType, 8.5);
          drawText(parts, 230, y, row.dimensions, 8.5);
          drawText(parts, 332, y, row.grossWeight, 8.5);
          drawText(parts, 388, y, row.netWeight, 8.5);
          drawText(parts, 444, y, row.volume, 8.5);
          drawText(parts, 500, y, row.location, 8.5);
        }
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
    drawText(parts, 36, 820, 'Kongsberg Automotive — Loading List', 13, 'F2', palette.white);
    drawText(parts, 36, 804, `Generated: ${dateStr} ${timeStr}`, 8.5, 'F1', palette.white);
    drawText(parts, 500, 812, `Page ${pageNum}`, 8.5, 'F1', palette.white);
  };
  const drawShipmentBand = (parts, y, shipment) => {
    const ref = formatShipmentRef(shipment.shipmentID);
    const planned = shipment.plannedCollection ? new Date(shipment.plannedCollection).toLocaleDateString('en-GB') : '—';
    drawRect(parts, 36, y, 523, 20, palette.light, true);
    drawLine(parts, 36, y, 559, y, palette.navy, 1);
    drawText(parts, 42, y + 7,  `Shipment ${ref}`,                                              9, 'F2', palette.navy);
    drawText(parts, 155, y + 7, `Dest: ${String(shipment.destinationName || '—').slice(0, 28)}`, 8, 'F1', palette.steel);
    drawText(parts, 355, y + 7, `Haulier: ${String(shipment.forwarderName || '—').slice(0, 18)}`, 8, 'F1', palette.steel);
    drawText(parts, 475, y + 7, `Planned: ${planned}`,                                           8, 'F1', palette.steel);
  };
  const drawColHeaders = (parts, y) => {
    drawRect(parts, 36, y, 523, 16, palette.navy, true);
    [['Pallet ID', 42], ['Type', 120], ['Location', 195], ['Gross Wt', 305], ['Dimensions (L×W×H mm)', 385]].forEach(([label, x]) =>
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
      drawText(parts, 195, y + 4, String(pallet.palletLocation || '—'), 8);
      drawText(parts, 305, y + 4, `${formatDecimal(pallet.grossWeight)} kg`, 8);
      drawText(parts, 385, y + 4, `${pallet.palletLength || 0} × ${pallet.palletWidth || 0} × ${pallet.palletHeight || 0}`, 8);
      drawLine(parts, 36, y, 559, y);
      rowIndex++;
    } else if (item.kind === 'empty') {
      drawText(parts, 42, y + 4, 'No pallets linked to this shipment.', 8.5, 'F1', palette.steel);
    }
    // 'gap' is just space — nothing drawn
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
  const result = await poolOrTx.request().input('shipmentId', sql.BigInt, shipmentId).query('SELECT * FROM log.ShipmentMain WHERE shipmentID = @shipmentId');
  return result.recordset[0] || null;
}


async function getShipmentContext(shipmentId) {
  const pool = await getPool();
  const shipment = await getShipmentById(pool, shipmentId);
  if (!shipment) { const err = new Error(`Shipment ${shipmentId} not found.`); err.statusCode = 404; throw err; }
  if (shipment.forwarderID) {
    const forwarderResult = await pool.request()
      .input('forwarderId', sql.BigInt, shipment.forwarderID)
      .query('SELECT TOP 1 forwarderName FROM log.Forwarders WHERE forwarderID = @forwarderId');
    shipment.forwarderName = forwarderResult.recordset[0]?.forwarderName || '';
  } else {
    shipment.forwarderName = '';
  }
  // Manual Outbound Shipments have no linked deliveries/pallets at all — their
  // cargo lives in ManualCargoItem instead (see
  // sql/migrate_manual_outbound_shipment.sql). Skip the DeliveryLink/PalletMain
  // joins entirely for these; downstream document generation
  // (createShipmentPackingListPdfBuffer) reads context.manualCargo instead of
  // context.pallets when shipment.IsManual is set.
  if (shipment.IsManual) {
    const cargoResult = await pool.request().input('shipmentId', sql.BigInt, shipmentId).query(`
      SELECT CargoID, Description, PackageCount, Weight, Length, Width, Height, Volume
      FROM log.ManualCargoItem
      WHERE ShipmentID = @shipmentId AND Removed = 0
      ORDER BY CargoID ASC`);
    return { shipment, deliveries: [], pallets: [], manualCargo: cargoResult.recordset };
  }

  const deliveries = await pool.request().input('shipmentId', sql.BigInt, shipmentId).query(`
    SELECT dm.deliveryID, dm.customerID, dm.dispatchDate, dm.completionDate, dm.deliveryService, dm.picksheetComment,
      CAST(ISNULL(dm.netWeight, 0) AS decimal(18,3)) AS netWeight, CAST(ISNULL(dm.grossWeight, 0) AS decimal(18,3)) AS grossWeight,
      CAST(ISNULL(dm.palletCount, 0) AS decimal(18,3)) AS palletCount, CAST(ISNULL(dm.deliveryVolume, 0) AS decimal(18,3)) AS deliveryVolume,
      d.destinationName, d.destinationStreet, d.destinationCity, d.destinationPostCode, d.destinationCountry,
    STUFF((
      SELECT '; ' + e.address
      FROM log.Email e
      WHERE e.ID = dm.customerID
      FOR XML PATH('')
    ), 1, 2, '') AS destinationEmail
    FROM log.ShipmentLink sl
      INNER JOIN log.DeliveryMain dm ON dm.deliveryID = sl.deliveryID
      LEFT JOIN log.Destinations d ON dm.customerID = d.destinationID
    WHERE sl.shipmentID = @shipmentId ORDER BY dm.deliveryID ASC`);
  const pallets = await pool.request().input('shipmentId', sql.BigInt, shipmentId).query(`SELECT sl.deliveryID, pm.palletID, pm.palletType, pm.palletFinish, CAST(ISNULL(pm.packagingWeight, 0) AS decimal(18,3)) AS packagingWeight, CAST(ISNULL(pm.grossWeight, 0) AS decimal(18,3)) AS grossWeight, CAST(ISNULL(pm.palletVolume, 0) AS decimal(18,3)) AS palletVolume, pm.palletLength, pm.palletWidth, pm.palletHeight, pm.palletLocation FROM log.ShipmentLink sl INNER JOIN log.DeliveryLink dl ON dl.deliveryID = sl.deliveryID INNER JOIN log.PalletMain pm ON pm.palletID = dl.palletID WHERE sl.shipmentID = @shipmentId AND ISNULL(pm.palletRemoved, 0) = 0 ORDER BY sl.deliveryID ASC, pm.palletID ASC`);
  return { shipment, deliveries: deliveries.recordset, pallets: pallets.recordset, manualCargo: [] };
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
  const trustedOrigin = `http://127.0.0.1:${process.env.PORT || 3000}`;
  const headers = { 'Content-Type': 'application/json', ...(req.headers.cookie ? { Cookie: req.headers.cookie } : {}) };

  const sapPost = (path, body) => fetch(new URL(path, trustedOrigin), {
    method: 'POST', headers, body: JSON.stringify(body),
  }).then(r => r.json());

  const sapDeliveryNumbers = deliveries.map(d => String(d.deliveryID));

  // Round 1 — parallel: LIPS (line items) + LIKP (delivery header: incoterms, consignee code)
  const [lipsBody, likpBody] = await Promise.all([
    sapPost('/api/sap/lips', { deliveries: sapDeliveryNumbers }),
    sapPost('/api/sap/likp', { deliveries: sapDeliveryNumbers }),
  ]);

  if (lipsBody?.success === false) {
    const err = new Error(`SAP LIPS query failed: ${(typeof lipsBody.error === 'string' ? lipsBody.error : lipsBody.error?.message) || 'unknown error'}`);
    err.statusCode = 502;
    throw err;
  }
  if (likpBody?.success === false) {
    const err = new Error(`SAP LIKP query failed: ${(typeof likpBody.error === 'string' ? likpBody.error : likpBody.error?.message) || 'unknown error'}`);
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

  // Round 2 — parallel: VBFA (invoice/stat value per line) + MARC (commodity/origin per material) + KNA1 (customer country)
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
    const err = new Error(`SAP VBFA query failed: ${(typeof vbfaBody.error === 'string' ? vbfaBody.error : vbfaBody.error?.message) || 'unknown error'}`);
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
      transformResponse: [(data) => data],  // skip auto-parse — keep raw text
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


// exportRoot must resolve to a real absolute Windows path (drive letter or
// UNC share) before we ever hand it to fs.mkdir/path.join. Without this
// check, a malformed value collapses silently into something like the
// bare string "\\?" (Node's Windows long-path prefix with nothing after
// it) and the only symptom is a cryptic "ENOENT ... mkdir '\\?'" — which
// gives no clue that the real problem is upstream config, not a disk/
// permissions issue. The most common cause: LOGISTICS_EXPORT_ROOT set in
// .env, but a stray Machine-scope Windows environment variable of the
// same name (visible to the LocalSystem account the service runs as)
// shadows it, since dotenv never overrides an already-set process.env
// value. Check with:
//   [Environment]::GetEnvironmentVariable('LOGISTICS_EXPORT_ROOT','Machine')
function assertValidExportRoot(exportRoot) {
  const value = String(exportRoot || '').trim();
  const looksValid = /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^?\\]/.test(value);
  if (!looksValid) {
    const err = new Error(
      `Logistics export folder path is misconfigured (LOGISTICS_EXPORT_ROOT resolved to "${value}"). ` +
      `This is usually a stray Windows environment variable of that name shadowing the .env value — check ` +
      `[Environment]::GetEnvironmentVariable('LOGISTICS_EXPORT_ROOT','Machine') on the server, fix or remove it, then restart the service.`
    );
    err.statusCode = 500;
    throw err;
  }
  return value;
}

function getShipmentFolderInfo(shipment) {
  const settings = getLogisticsSettings();
  const exportRoot = assertValidExportRoot(settings.exportRoot);
  const shipmentRef = formatShipmentRef(shipment.shipmentID);
  const customerPath = path.join(exportRoot, sanitizeFolderSegment(shipment.destinationName || 'Unknown Customer'));
  return { shipmentRef, customerPath, shipmentPath: path.join(customerPath, shipmentRef) };
}


// Node's native fs.mkdir(path, { recursive: true }) has a documented class
// of bug on Windows: the recursive walk is done natively (via libuv), and
// for some absolute paths it can mis-resolve once it steps past the drive
// root, ending up trying to create the bare long-path prefix ("\\?") as if
// it were a real directory — surfacing as an opaque "ENOENT ... mkdir
// '\\?'" that gives no hint anything is configured correctly or not (we
// confirmed the real LOGISTICS_EXPORT_ROOT here is a perfectly well-formed
// path — assertValidExportRoot above correctly lets it through). Building
// each directory level ourselves with plain, non-recursive mkdir calls
// avoids that native code path entirely.
async function mkdirRecursiveSafe(targetPath) {
  const toCreate = [];
  let current = targetPath;
  while (true) {
    try {
      await fsp.access(current, fs.constants.F_OK);
      break; // this level (and everything above it) already exists
    } catch {
      toCreate.unshift(current);
      const parent = path.dirname(current);
      if (parent === current) break; // reached the drive/UNC root
      current = parent;
    }
  }
  for (const dir of toCreate) {
    try {
      await fsp.mkdir(dir);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

async function ensureShipmentFolder(shipment) {
  const folder = getShipmentFolderInfo(shipment);
  await mkdirRecursiveSafe(folder.customerPath);
  await mkdirRecursiveSafe(folder.shipmentPath);
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
    .query(`INSERT INTO log.ShipmentEvents (shipmentID, eventCategory, eventDescription)
            VALUES (@shipmentId, @category, @description)`);
}


async function syncShipmentAggregateData(shipmentId) {
  const pool = await getPool();

  // Manual Outbound Shipments have no PalletMain/DeliveryLink data to resync
  // from here — running the normal resync below against those (always-empty,
  // for a manual shipment) joins would silently zero grossWeight/palletCount/
  // shipmentVolume back out to 0, which is exactly what happened before this
  // branch existed: any ShipmentMain row that had "Create Packing List" run
  // against it while still classed as a normal shipment got its totals wiped
  // and stayed wiped, because the old code path never wrote them back from
  // ManualCargoItem afterwards. Actively re-deriving via
  // recalcManualShipmentTotals here (rather than just trusting whatever is
  // currently stored) self-heals any shipment left in that state and keeps
  // this function's contract — "the totals you get back are freshly synced"
  // — true for manual shipments too.
  const manualCheck = await pool.request().input('shipmentId', sql.BigInt, shipmentId)
    .query('SELECT IsManual FROM log.ShipmentMain WHERE shipmentID = @shipmentId');
  if (manualCheck.recordset[0]?.IsManual) {
    await recalcManualShipmentTotals(pool, shipmentId);
    return getShipmentContext(shipmentId);
  }

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const deliveryResult = await tx.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .query('SELECT deliveryID FROM log.ShipmentLink WHERE shipmentID = @shipmentId');
    const palletResult = await tx.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .query(`
        SELECT
          sl.deliveryID,
          pm.palletID,
          CAST(ISNULL(pm.packagingWeight, 0) AS decimal(18,3)) AS packagingWeight,
          CAST(ISNULL(pm.grossWeight, 0) AS decimal(18,3)) AS grossWeight,
          CAST(ISNULL(pm.palletVolume, 0) AS decimal(18,3)) AS palletVolume
        FROM log.ShipmentLink sl
        INNER JOIN log.DeliveryLink dl ON dl.deliveryID = sl.deliveryID
        INNER JOIN log.PalletMain pm ON pm.palletID = dl.palletID
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
          UPDATE log.DeliveryMain
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
        UPDATE log.ShipmentMain
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
    const result = await pool.request().query('SELECT * FROM log.ShipmentMain'); 
    res.json(result.recordset); }
  catch (err) { res.status(500).json({ error: err.message }); }
});


// ── Shipment queues ──
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
        fa.forwarderMode,
        CAST(ISNULL(sm.collectionStatus, 0) AS bit) AS collectionStatus,
        CAST(ISNULL(sm.deliveryStatus, 0) AS bit) AS deliveryStatus,
        CASE WHEN ISNULL(sm.plannedDelivery, '1900-01-01') > '1900-01-01' THEN sm.plannedDelivery ELSE sm.plannedCollection END AS plannedMovement
      FROM log.ShipmentMain sm
      OUTER APPLY (
        SELECT TOP 1 f.forwarderName, f.forwarderMode
        FROM log.Forwarders f
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


// ── Haulier On-Time Performance report ────────────────────────────────────────
// Combines outbound (ShipmentMain.plannedDelivery vs actualDelivery) and
// inbound (log.PurchaseOrderShipment.ExpectedEta vs ReceivedAtUtc) legs —
// same UNION ALL shape as shipmentcost.js's /analytics, since a haulier's
// on-time record should reflect both directions, not just outbound. Only
// counts shipments that actually have both a planned and an actual/received
// date (nothing still in flight, nothing cancelled) — "on time" is actual
// date <= planned date, compared as dates only (time-of-day ignored). Uses
// DATEADD(day, DATEDIFF(day, 0, x), 0) to truncate to midnight rather than
// CAST(x AS DATE) — SQL Server 2005 has no DATE type (added in 2008), same
// constraint as everywhere else in this codebase (see performancesql.js's
// note near line 785).
// Same Forwarders fan-out fix as shipmentcost.js's COMBINED_COST_OUTBOUND/
// INBOUND (see that file's comment for the full writeup) — Forwarders has
// one row PER MODE per forwarderID, so a plain LEFT JOIN here was counting
// every on-time/late shipment once per mode-row that forwarder happens to
// have on file, inflating byHaulier's totals the same way. OUTER APPLY
// TOP 1 pins it to one row, matching the pattern already used correctly
// a little further up this file (the in-transit query's OUTER APPLY fa).
const OTIF_OUTBOUND = `
    SELECT fa.forwarderName,
           sm.destinationCountry AS country,
           sm.destinationName    AS place,
           sm.actualDelivery     AS periodDate,
           CASE WHEN DATEADD(day, DATEDIFF(day, 0, sm.actualDelivery), 0) <= DATEADD(day, DATEDIFF(day, 0, sm.plannedDelivery), 0) THEN 1 ELSE 0 END AS isOnTime
    FROM log.ShipmentMain sm
    OUTER APPLY (
        SELECT TOP 1 f.forwarderName
        FROM log.Forwarders f
        WHERE f.forwarderID = sm.forwarderID
    ) fa
    WHERE sm.actualDelivery IS NOT NULL AND sm.plannedDelivery IS NOT NULL
      AND ISNULL(sm.shipmentCancelled, 0) = 0`;
const OTIF_INBOUND = `
    SELECT fa.forwarderName,
           d.destinationCountry AS country,
           d.destinationName    AS place,
           ps.ReceivedAtUtc     AS periodDate,
           CASE WHEN DATEADD(day, DATEDIFF(day, 0, ps.ReceivedAtUtc), 0) <= DATEADD(day, DATEDIFF(day, 0, ps.ExpectedEta), 0) THEN 1 ELSE 0 END AS isOnTime
    FROM log.PurchaseOrderShipment ps
    OUTER APPLY (
        SELECT TOP 1 f.forwarderName
        FROM log.Forwarders f
        WHERE f.forwarderID = ps.ForwarderID
    ) fa
    LEFT JOIN log.Destinations d ON d.destinationID = ps.OriginDestinationID
    WHERE ps.ReceivedAtUtc IS NOT NULL AND ps.ExpectedEta IS NOT NULL
      AND ps.CancelledAtUtc IS NULL`;
const OTIF_COMBINED = `(${OTIF_OUTBOUND} UNION ALL ${OTIF_INBOUND}) o`;

// Read-only dashboard, moved into the Logistics page's Reports section (see
// sql/migrate_log_reports_permission.sql) — same LOG_ADMIN/LOG_MRP/
// LOG_REPORTS gate as shipmentcost.js's /analytics, for the same reason
// (shared Reports section, Stock Value Overview/by Price sit alongside this
// and are LOG_MRP-gated, so this needs to accept LOG_MRP too or a LOG_MRP-
// only viewer would see a tile here that 403s on click).
router.get('/otif-report', requireAnyPermission(['LOG_ADMIN', 'LOG_MRP', 'LOG_REPORTS']), async (req, res) => {
  try {
    const pool   = await getPool();
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 60);

    const byHaulier = await pool.request()
      .input('months', sql.Int, months)
      .query(`SELECT ISNULL(o.forwarderName, 'Unassigned') AS haulier,
                     SUM(o.isOnTime) AS onTime, COUNT(*) AS total
              FROM ${OTIF_COMBINED}
              WHERE o.periodDate >= DATEADD(month, -@months, GETDATE())
              GROUP BY o.forwarderName
              ORDER BY total DESC`);

    const byCountry = await pool.request()
      .input('months', sql.Int, months)
      .query(`SELECT o.country,
                     SUM(o.isOnTime) AS onTime, COUNT(*) AS total
              FROM ${OTIF_COMBINED}
              WHERE o.periodDate >= DATEADD(month, -@months, GETDATE())
                AND o.country IS NOT NULL
              GROUP BY o.country
              ORDER BY total DESC`);

    const byDestination = await pool.request()
      .input('months', sql.Int, months)
      .query(`SELECT TOP 15 o.place AS destination,
                     SUM(o.isOnTime) AS onTime, COUNT(*) AS total
              FROM ${OTIF_COMBINED}
              WHERE o.periodDate >= DATEADD(month, -@months, GETDATE())
                AND o.place IS NOT NULL
              GROUP BY o.place
              ORDER BY total DESC`);

    const byMonth = await pool.request()
      .input('months', sql.Int, months)
      .query(`SELECT YEAR(o.periodDate) AS yr, MONTH(o.periodDate) AS mo,
                     SUM(o.isOnTime) AS onTime, COUNT(*) AS total
              FROM ${OTIF_COMBINED}
              WHERE o.periodDate >= DATEADD(month, -@months, GETDATE())
              GROUP BY YEAR(o.periodDate), MONTH(o.periodDate)
              ORDER BY yr ASC, mo ASC`);

    const totals = await pool.request()
      .input('months', sql.Int, months)
      .query(`SELECT SUM(o.isOnTime) AS onTime, COUNT(*) AS total
              FROM ${OTIF_COMBINED}
              WHERE o.periodDate >= DATEADD(month, -@months, GETDATE())`);

    res.json({
      success: true,
      months,
      data: { totals: totals.recordset[0], byHaulier: byHaulier.recordset, byCountry: byCountry.recordset, byDestination: byDestination.recordset, byMonth: byMonth.recordset },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── Bulk mark collected ───────────────────────────────────────────────────────
// Also reachable by WAREHOUSE_OP — Warehouse's own Outbound Deliveries tile
// (private/js/warehouse.js's wdSubmitMarkCollected) uses this same route to
// confirm a shipment collected; everything else on Awaiting Collection
// (date changes, loading lists, unbook) stays LOG_PLANNING-only.
router.post('/mark-collected-bulk', requireAnyPermission(['LOG_PLANNING', 'WAREHOUSE_OP']), async (req, res) => {
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
          UPDATE log.ShipmentMain
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


// ── Loading list PDF (streams directly to browser) ────────────────────────────
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
        FROM log.ShipmentMain sm
        OUTER APPLY (SELECT TOP 1 f.forwarderName FROM log.Forwarders f WHERE f.forwarderID = sm.forwarderID) fa
        WHERE sm.shipmentID = @shipmentId AND ISNULL(sm.shipmentCancelled, 0) = 0`);
    if (!shipResult.recordset.length) continue;

    const palletResult = await pool.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .query(`
        SELECT pm.palletID, pm.palletType, pm.palletLocation,
          CAST(ISNULL(pm.grossWeight, 0) AS decimal(18,3)) AS grossWeight,
          pm.palletLength, pm.palletWidth, pm.palletHeight
        FROM log.ShipmentLink sl
        INNER JOIN log.DeliveryLink dl ON dl.deliveryID = sl.deliveryID
        INNER JOIN log.PalletMain   pm ON pm.palletID   = dl.palletID
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


// ── Update planned collection date for multiple shipments ─────────────────────
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
    UPDATE log.ShipmentMain SET plannedCollection = @date
    WHERE shipmentID IN (${inClause}) AND ISNULL(shipmentCancelled, 0) = 0`);
  stampDbChange(req.session?.user?.username, 'ShipmentMain');
  res.json({ success: true });
});


// ── Write ShipmentEvents entries ──────────────────────────────────────────────
router.post('/events', requirePermission('LOG_PLANNING'), async (req, res) => {
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
      DELETE FROM log.ShipmentLink
      WHERE shipmentID IN (${deleteClause})
    `);

    const updateRequest = tx.request();
    const updateClause = createInClause(updateRequest, shipmentIds, 'updateShipmentId');
    const result = await updateRequest.query(`
      UPDATE log.ShipmentMain
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
        UPDATE log.ShipmentMain
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
        UPDATE log.ShipmentMain
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


// ── Bulk mark delivered — In Transit's mass "mark selected as delivered on
// a given date" action, mirrors mark-collected-bulk's per-shipment
// try/catch-and-continue shape rather than one transaction, so one bad
// shipment (already delivered, cancelled, etc.) doesn't block the rest.
router.post('/mark-delivered-bulk', requirePermission('LOG_PLANNING'), async (req, res) => {
  const shipmentIds = normalizeIdList(req.body.shipmentIDs);
  if (!shipmentIds.length) return res.status(400).json({ success: false, error: 'No shipments selected.' });
  const actualDelivery = req.body.actualDelivery ? new Date(req.body.actualDelivery) : new Date();

  const pool = await getPool();
  const completed = [];
  const failed    = [];

  for (const shipmentId of shipmentIds) {
    try {
      const result = await pool.request()
        .input('shipmentId',     sql.BigInt,   shipmentId)
        .input('actualDelivery', sql.DateTime, actualDelivery)
        .query(`
          UPDATE log.ShipmentMain
          SET deliveryStatus = 1, actualDelivery = COALESCE(@actualDelivery, GETDATE())
          WHERE shipmentID = @shipmentId
            AND ISNULL(shipmentCancelled, 0) = 0
            AND ISNULL(collectionStatus,  0) = 1
            AND ISNULL(deliveryStatus,    0) = 0;
          SELECT @@ROWCOUNT AS affectedRows;
        `);
      if (!result.recordset[0]?.affectedRows) throw new Error('Already delivered, not yet collected, or cancelled.');
      const username = req.session?.user?.username || 'unknown';
      await writeShipmentEvent(pool, shipmentId, 'DELIVERED',
        `Delivered on ${actualDelivery.toLocaleDateString('en-GB')} - confirmed by ${username} (bulk)`);
      completed.push(shipmentId);
    } catch (err) {
      failed.push({ shipmentID: shipmentId, error: err.message });
    }
  }

  if (!completed.length) return res.status(409).json({ success: false, error: 'No shipments were updated.', data: { completed, failed } });
  res.json({ success: true, data: { completed, failed } });
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
            UPDATE log.ShipmentMain
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
        UPDATE log.ShipmentMain
        SET bookingStatus = 1
        WHERE shipmentID IN (${inClause})
          AND ISNULL(shipmentCancelled, 0) = 0
          AND ISNULL(bookingStatus, 0) = 0;

        SELECT @@ROWCOUNT AS affectedRows;
      `);
      updated = Number(result.recordset[0]?.affectedRows || 0);
    }

    await tx.commit();

    // Insert ShipmentCost rows for each booked shipment that has a cost
    const pool2 = await getPool();
    for (const item of shipmentUpdates) {
      if (item.skipCost) continue;

      // Translate the booked forwarder's own mode/type (Forwarders.forwarderMode,
      // e.g. "Road") into the canonical ModeOfTransport value via
      // log.ForwarderModeMapping — previously these INSERTs didn't set
      // modeOfTransport at all, so every outbound cost line (manual and
      // SAP-driven shipments alike) ended up with it NULL, and
      // lookupMaterialGroup (routes/materialgroups.js) could never use a
      // mode-specific mapping row, only a GL account's default. Best-effort:
      // never throws, falls back to the raw forwarderMode if unmapped.
      const modeOfTransport = await lookupModeOfTransport(item.forwarderMode);

      // Freight cost (costType 1)
      if (item.expectedCost != null) {
        try {
          await pool2.request()
            .input('shipmentID',      sql.BigInt,        item.shipmentID)
            .input('costType',        sql.NVarChar(3),   '1')
            .input('costElement',     sql.NVarChar(6),   item.elementCode || null)
            .input('costCenter',      sql.NVarChar(20),  item.costCenter  || null)
            .input('expectedCost',    sql.Decimal(18,2), item.expectedCost)
            .input('actualCost',      sql.Decimal(18,2), 0)
            .input('migoStatus',      sql.Bit,           0)
            .input('modeOfTransport', sql.NVarChar(20),  modeOfTransport)
            .query(`INSERT INTO log.ShipmentCost
                      (shipmentID, costType, costElement, costCenter, expectedCost, actualCost, migoStatus, modeOfTransport)
                    VALUES
                      (@shipmentID, @costType, @costElement, @costCenter, @expectedCost, @actualCost, @migoStatus, @modeOfTransport)`);
        } catch (_) {}
      }

      // Customs cost (costType 2) — KN only, £50 DDP / £0 DAP
      if (item.customsCost != null) {
        try {
          await pool2.request()
            .input('shipmentID',      sql.BigInt,        item.shipmentID)
            .input('costType',        sql.NVarChar(3),   '2')
            .input('costElement',     sql.NVarChar(6),   '603120')
            .input('costCenter',      sql.NVarChar(20),  item.costCenter || null)
            .input('expectedCost',    sql.Decimal(18,2), item.customsCost)
            .input('actualCost',      sql.Decimal(18,2), 0)
            .input('migoStatus',      sql.Bit,           0)
            .input('modeOfTransport', sql.NVarChar(20),  modeOfTransport)
            .query(`INSERT INTO log.ShipmentCost
                      (shipmentID, costType, costElement, costCenter, expectedCost, actualCost, migoStatus, modeOfTransport)
                    VALUES
                      (@shipmentID, @costType, @costElement, @costCenter, @expectedCost, @actualCost, @migoStatus, @modeOfTransport)`);
        } catch (_) {}
      }
    }

    res.json({ success: true, data: { updated } });
  } catch (err) {
    try { if (tx) await tx.rollback(); } catch (_) {}
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});


// ── Unbook a shipment ─────────────────────────────────────────────────────
// Reverses a booking so it goes back into Awaiting Booking. Fixes a real
// double-cost bug: /mark-booked above inserts a ShipmentCost row every time
// it runs, but nothing previously cleared that row when a shipment was
// un-booked (e.g. via the Booking Status checkbox in Edit Dates & Status,
// the only way to do this before now) -- re-booking then inserted a second
// row, duplicating the freight cost in the expected-costs table. Unbooking
// now deletes any not-yet-MIGO'd cost rows for the shipment as part of the
// same action (migoStatus = 1 rows are left alone -- those have already
// been processed in SAP and shouldn't be touched), along with the planned
// collection date and tracking number, since both get re-entered at
// booking time anyway. Only allowed while the shipment is still genuinely
// awaiting collection -- not already collected/delivered, not cancelled.
router.post('/unbook', requirePermission('LOG_PLANNING'), async (req, res) => {
  const shipmentIds = normalizeIdList(req.body.shipmentIDs);
  if (!shipmentIds.length) return res.status(400).json({ success: false, error: 'No shipments selected.' });

  const pool = await getPool();
  const completed = [];
  const failed    = [];

  for (const shipmentId of shipmentIds) {
    let tx = null;
    try {
      tx = new sql.Transaction(pool);
      await tx.begin();

      const result = await tx.request()
        .input('shipmentId', sql.BigInt, shipmentId)
        .query(`
          UPDATE log.ShipmentMain
          SET bookingStatus = 0, plannedCollection = NULL, trackingNumber = NULL
          WHERE shipmentID = @shipmentId
            AND ISNULL(shipmentCancelled, 0) = 0
            AND ISNULL(bookingStatus, 0) = 1
            AND ISNULL(collectionStatus, 0) = 0;

          SELECT @@ROWCOUNT AS affectedRows;
        `);
      if (!result.recordset[0]?.affectedRows) throw new Error('Not currently booked and awaiting collection.');

      await tx.request()
        .input('shipmentId', sql.BigInt, shipmentId)
        .query(`
          DELETE FROM log.ShipmentCost
          WHERE shipmentID = @shipmentId AND ISNULL(migoStatus, 0) = 0
        `);

      await tx.commit();
      tx = null;

      const username = req.session?.user?.username || 'unknown';
      await writeShipmentEvent(pool, shipmentId, 'CORRECTION',
        `Unbooked by ${username}: expected costs cleared, planned collection and tracking number reset.`);
      completed.push(shipmentId);
    } catch (err) {
      try { if (tx) await tx.rollback(); } catch (_) {}
      failed.push({ shipmentID: shipmentId, error: err.message });
    }
  }

  if (!completed.length) return res.status(409).json({ success: false, error: 'No shipments were unbooked.', data: { completed, failed } });
  res.json({ success: true, data: { completed, failed } });
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
      SELECT dm.deliveryID, dm.customerID, dm.dispatchDate, dm.completionDate, dm.deliveryService, dm.picksheetComment, dm.incoterms,
        CAST(ISNULL(dm.netWeight, 0) AS decimal(18,3)) AS netWeight, CAST(ISNULL(dm.grossWeight, 0) AS decimal(18,3)) AS grossWeight,
        CAST(ISNULL(dm.palletCount, 0) AS decimal(18,3)) AS palletCount, CAST(ISNULL(dm.deliveryVolume, 0) AS decimal(18,3)) AS deliveryVolume,
        d.destinationName, d.destinationStreet, d.destinationCity, d.destinationPostCode, d.destinationCountry, d.defaultIncoterms,
        STUFF((
          SELECT '; ' + e.address
          FROM log.Email e
          WHERE e.ID = dm.customerID
          FOR XML PATH('')
        ), 1, 2, '') AS destinationEmail
      FROM log.DeliveryMain dm 
        LEFT JOIN log.Destinations d ON d.destinationID = dm.customerID 
        LEFT JOIN log.ShipmentLink sl ON sl.deliveryID = dm.deliveryID 
      WHERE dm.deliveryID IN (${inClause}) AND dm.completionStatus = 1
        AND ISNULL(dm.deliveryCancelled, 0) = 0
        AND ISNULL(dm.pendingPackagingData, 0) = 0
        AND sl.deliveryID IS NULL
      ORDER BY dm.deliveryID ASC`);

    const deliveries = deliveriesResult.recordset;
    if (deliveries.length !== deliveryIDs.length) 
      throw new Error('One or more deliveries are no longer available for shipment creation. Please refresh and try again.');

    const customerIds = [...new Set(deliveries.map(row => String(row.customerID)))];
    if (customerIds.length !== 1)
      throw new Error('Selected deliveries must all belong to the same customer.');

    // Enforce incoterms consistency — delivery-level incoterms take priority over destination default
    const effectiveIncoterms = deliveries.map(row =>
      String(row.incoterms || row.defaultIncoterms || '').trim().toUpperCase()
    );
    const uniqueIncoterms = [...new Set(effectiveIncoterms.filter(Boolean))];
    if (uniqueIncoterms.length > 1) {
      const detail = deliveries.map(row =>
        `#${row.deliveryID} → ${String(row.incoterms || row.defaultIncoterms || '?').toUpperCase()}`
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
    const insertResult = await tx.request().input('originID', sql.BigInt, settings.originID).input('originName', sql.NVarChar, settings.originName).input('originStreet', sql.NVarChar, settings.originStreet).input('originCity', sql.NVarChar, settings.originCity).input('originPostCode', sql.NVarChar, settings.originPostCode).input('originCountry', sql.NVarChar, settings.originCountry).input('destinationID', sql.BigInt, shipmentDraft.destinationID).input('destinationName', sql.NVarChar, shipmentDraft.destinationName).input('destinationStreet', sql.NVarChar, shipmentDraft.destinationStreet).input('destinationCity', sql.NVarChar, shipmentDraft.destinationCity).input('destinationPostCode', sql.NVarChar, shipmentDraft.destinationPostCode).input('destinationCountry', sql.NVarChar, shipmentDraft.destinationCountry).input('netWeight', sql.Decimal(18, 3), totals.netWeight).input('grossWeight', sql.Decimal(18, 3), totals.grossWeight).input('palletCount', sql.Decimal(18, 3), totals.palletCount).input('shipmentVolume', sql.Decimal(18, 3), totals.shipmentVolume).input('plannedCollection', sql.DateTime, shipmentDraft.plannedCollection).input('actualCollection', sql.DateTime, shipmentDraft.actualCollection).input('collectionStatus', sql.Bit, shipmentDraft.collectionStatus).input('forwarderID', sql.BigInt, shipmentDraft.forwarderID).input('trackingNumber', sql.NVarChar, shipmentDraft.trackingNumber || null).input('incoTerms', sql.NVarChar, shipmentDraft.incoTerms || null).input('customsRequired', sql.Bit, shipmentDraft.customsRequired).input('customsComplete', sql.Bit, shipmentDraft.customsComplete).input('shipmentCancelled', sql.Bit, shipmentDraft.shipmentCancelled).query(`INSERT INTO log.ShipmentMain (originID, originName, originStreet, originCity, originPostCode, originCountry, destinationID, destinationName, destinationStreet, destinationCity, destinationPostCode, destinationCountry, netWeight, grossWeight, palletCount, shipmentVolume, plannedCollection, actualCollection, collectionStatus, forwarderID, trackingNumber, incoTerms, customsRequired, customsComplete, shipmentCancelled) VALUES (@originID, @originName, @originStreet, @originCity, @originPostCode, @originCountry, @destinationID, @destinationName, @destinationStreet, @destinationCity, @destinationPostCode, @destinationCountry, @netWeight, @grossWeight, @palletCount, @shipmentVolume, @plannedCollection, @actualCollection, @collectionStatus, @forwarderID, @trackingNumber, @incoTerms, @customsRequired, @customsComplete, @shipmentCancelled); SELECT SCOPE_IDENTITY() AS shipmentID;`);
    const shipmentID = Number(insertResult.recordset[0].shipmentID);
    
    for (const deliveryID of deliveryIDs) 
      await tx.request().input('shipmentID', sql.BigInt, shipmentID).input('deliveryID', sql.BigInt, deliveryID).query('INSERT INTO log.ShipmentLink (shipmentID, deliveryID) VALUES (@shipmentID, @deliveryID)');
    
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


router.post('/:shipmentId/create-folder', requirePermission('LOG_PLANNING'), async (req, res) => {
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


// ── Manual Outbound Shipment ──────────────────────────────────────────────────
// For goods sent that are NOT managed through SAP and never go through the
// picksheet/pallet-builder process — see
// sql/migrate_manual_outbound_shipment.sql for the full "why a new table,
// not PalletMain" reasoning. A manual shipment has no linked deliveries at
// all (DeliveryLink stays empty for it); its cargo lives in
// ManualCargoItem instead, and ShipmentMain.IsManual flags it so
// freightbooking.js knows to build KN cargoItems from that table rather
// than the usual DeliveryLink -> PalletMain join.
router.post('/create-manual', requirePermission('LOG_PLANNING'), async (req, res) => {
  try {
    const destinationID = toNullableInteger(req.body.destinationID);
    if (!destinationID) {
      return res.status(400).json({ success: false, error: 'Select a destination before creating a manual shipment.' });
    }

    const pool = await getPool();
    const destResult = await pool.request()
      .input('destinationId', sql.BigInt, destinationID)
      .query('SELECT destinationName, destinationStreet, destinationCity, destinationPostCode, destinationCountry, defaultIncoterms FROM log.Destinations WHERE destinationID = @destinationId');
    const dest = destResult.recordset[0];
    if (!dest) return res.status(400).json({ success: false, error: 'Destination not found.' });

    const settings = getLogisticsSettings();
    const shipmentDraft = {
      destinationID,
      destinationName: String(req.body.destinationName || dest.destinationName || '').trim(),
      destinationStreet: String(req.body.destinationStreet || dest.destinationStreet || '').trim(),
      destinationCity: String(req.body.destinationCity || dest.destinationCity || '').trim(),
      destinationPostCode: String(req.body.destinationPostCode || dest.destinationPostCode || '').trim(),
      destinationCountry: String(req.body.destinationCountry || dest.destinationCountry || '').trim(),
      plannedCollection: req.body.plannedCollection ? new Date(req.body.plannedCollection) : null,
      forwarderID: toNullableInteger(req.body.forwarderID),
      incoTerms: String(req.body.incoTerms || dest.defaultIncoterms || '').trim(),
      customsRequired: toBool(req.body.customsRequired),
      customsComplete: toBool(req.body.customsComplete),
    };

    const insertResult = await pool.request()
      .input('originID', sql.BigInt, settings.originID).input('originName', sql.NVarChar, settings.originName).input('originStreet', sql.NVarChar, settings.originStreet).input('originCity', sql.NVarChar, settings.originCity).input('originPostCode', sql.NVarChar, settings.originPostCode).input('originCountry', sql.NVarChar, settings.originCountry)
      .input('destinationID', sql.BigInt, shipmentDraft.destinationID).input('destinationName', sql.NVarChar, shipmentDraft.destinationName).input('destinationStreet', sql.NVarChar, shipmentDraft.destinationStreet).input('destinationCity', sql.NVarChar, shipmentDraft.destinationCity).input('destinationPostCode', sql.NVarChar, shipmentDraft.destinationPostCode).input('destinationCountry', sql.NVarChar, shipmentDraft.destinationCountry)
      .input('plannedCollection', sql.DateTime, shipmentDraft.plannedCollection)
      .input('forwarderID', sql.BigInt, shipmentDraft.forwarderID)
      .input('incoTerms', sql.NVarChar, shipmentDraft.incoTerms || null)
      .input('customsRequired', sql.Bit, shipmentDraft.customsRequired)
      .input('customsComplete', sql.Bit, shipmentDraft.customsComplete)
      .query(`INSERT INTO log.ShipmentMain
                (originID, originName, originStreet, originCity, originPostCode, originCountry,
                 destinationID, destinationName, destinationStreet, destinationCity, destinationPostCode, destinationCountry,
                 netWeight, grossWeight, palletCount, shipmentVolume,
                 plannedCollection, collectionStatus, forwarderID, incoTerms, customsRequired, customsComplete, shipmentCancelled, IsManual)
              VALUES
                (@originID, @originName, @originStreet, @originCity, @originPostCode, @originCountry,
                 @destinationID, @destinationName, @destinationStreet, @destinationCity, @destinationPostCode, @destinationCountry,
                 0, 0, 0, 0,
                 @plannedCollection, 0, @forwarderID, @incoTerms, @customsRequired, @customsComplete, 0, 1);
              SELECT SCOPE_IDENTITY() AS shipmentID;`);

    const shipmentID = Number(insertResult.recordset[0].shipmentID);
    const username = req.session?.user?.username || 'unknown';
    stampDbChange(username, 'ShipmentMain');
    await writeShipmentEvent(pool, shipmentID, 'CREATED', `Manual shipment created by ${username} — ${shipmentDraft.destinationName}`);

    const shipment = await getShipmentById(pool, shipmentID);
    res.status(201).json({ success: true, data: { shipmentID, shipmentRef: formatShipmentRef(shipmentID), shipment } });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});


// Recomputes ShipmentMain's stored aggregate columns from ManualCargoItem —
// mirrors how DeliveryMain's own aggregates get summed from PalletMain at
// completion time (see /:deliveryId/complete in deliverymain.js), just for
// the manual-cargo path instead. netWeight is set equal to grossWeight —
// manual cargo entry only asks for one weight per line, there's no
// separate tare/net concept to enter by hand the way SAP delivery data has.
async function recalcManualShipmentTotals(pool, shipmentId) {
  await pool.request().input('shipmentId', sql.BigInt, shipmentId).query(`
    UPDATE log.ShipmentMain SET
      grossWeight = t.totalWeight,
      netWeight = t.totalWeight,
      palletCount = t.totalPackages,
      shipmentVolume = t.totalVolume
    FROM log.ShipmentMain sm
    CROSS APPLY (
      SELECT ISNULL(SUM(Weight), 0) AS totalWeight,
             ISNULL(SUM(PackageCount), 0) AS totalPackages,
             ISNULL(SUM(Volume), 0) AS totalVolume
      FROM log.ManualCargoItem
      WHERE ShipmentID = sm.shipmentID AND Removed = 0
    ) t
    WHERE sm.shipmentID = @shipmentId`);
}


// ── Manual Cargo Items (Manual Outbound Shipment cargo lines) ────────────────
router.get('/:shipmentId/manual-cargo', requirePermission('LOG_PLANNING'), async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('shipmentId', sql.BigInt, req.params.shipmentId)
      .query(`SELECT CargoID, ShipmentID, Description, PackageCount, Weight, Length, Width, Height, Volume, CreatedAtUtc, CreatedBy
              FROM log.ManualCargoItem
              WHERE ShipmentID = @shipmentId AND Removed = 0
              ORDER BY CargoID ASC`);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:shipmentId/manual-cargo', requirePermission('LOG_PLANNING'), async (req, res) => {
  try {
    const shipmentId = req.params.shipmentId;
    const pool = await getPool();

    const shipmentResult = await pool.request().input('shipmentId', sql.BigInt, shipmentId)
      .query('SELECT IsManual FROM log.ShipmentMain WHERE shipmentID = @shipmentId');
    const shipmentRow = shipmentResult.recordset[0];
    if (!shipmentRow) return res.status(404).json({ success: false, error: 'Shipment not found.' });
    if (!shipmentRow.IsManual) return res.status(400).json({ success: false, error: 'Cargo lines can only be added to a manual shipment.' });

    const description = String(req.body.description || '').trim() || null;
    const packageCount = Math.max(1, Number.parseInt(req.body.packageCount, 10) || 1);
    const weight = toDecimal(req.body.weight);
    const length = req.body.length !== undefined && req.body.length !== '' ? toDecimal(req.body.length) : null;
    const width  = req.body.width  !== undefined && req.body.width  !== '' ? toDecimal(req.body.width)  : null;
    const height = req.body.height !== undefined && req.body.height !== '' ? toDecimal(req.body.height) : null;
    // Volume in m3 from L/W/H in cm — matches the KN cargoItem convention
    // elsewhere (buildBookingPayload multiplies pallet dimensions by 10 to
    // go cm -> mm for KN's own MMT unit); here we just need m3 for the
    // shipment's own totals, so /1,000,000 converts cm3 -> m3 directly.
    const volume = (length != null && width != null && height != null)
      ? (length * width * height) / 1000000
      : null;

    if (weight <= 0) {
      return res.status(400).json({ success: false, error: 'Weight must be greater than 0.' });
    }

    const username = req.session?.user?.username || 'unknown';
    await pool.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .input('description', sql.NVarChar, description)
      .input('packageCount', sql.Int, packageCount)
      .input('weight', sql.Decimal(18, 3), weight)
      .input('length', sql.Decimal(18, 2), length)
      .input('width', sql.Decimal(18, 2), width)
      .input('height', sql.Decimal(18, 2), height)
      .input('volume', sql.Decimal(18, 3), volume)
      .input('createdBy', sql.NVarChar, username)
      .query(`INSERT INTO log.ManualCargoItem (ShipmentID, Description, PackageCount, Weight, Length, Width, Height, Volume, CreatedBy)
              VALUES (@shipmentId, @description, @packageCount, @weight, @length, @width, @height, @volume, @createdBy)`);

    await recalcManualShipmentTotals(pool, shipmentId);
    res.status(201).json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/manual-cargo/:cargoId', requirePermission('LOG_PLANNING'), async (req, res) => {
  try {
    const cargoId = req.params.cargoId;
    const pool = await getPool();
    const currentResult = await pool.request().input('cargoId', sql.Int, cargoId)
      .query('SELECT ShipmentID, Description, PackageCount, Weight, Length, Width, Height FROM log.ManualCargoItem WHERE CargoID = @cargoId');
    const current = currentResult.recordset[0];
    if (!current) return res.status(404).json({ success: false, error: 'Cargo line not found.' });

    const description   = req.body.description   !== undefined ? (String(req.body.description || '').trim() || null) : current.Description;
    const packageCount  = req.body.packageCount  !== undefined ? Math.max(1, Number.parseInt(req.body.packageCount, 10) || 1) : current.PackageCount;
    const weight         = req.body.weight        !== undefined ? toDecimal(req.body.weight) : current.Weight;
    const length = req.body.length !== undefined ? (req.body.length === '' ? null : toDecimal(req.body.length)) : current.Length;
    const width  = req.body.width  !== undefined ? (req.body.width  === '' ? null : toDecimal(req.body.width))  : current.Width;
    const height = req.body.height !== undefined ? (req.body.height === '' ? null : toDecimal(req.body.height)) : current.Height;
    const volume = (length != null && width != null && height != null)
      ? (Number(length) * Number(width) * Number(height)) / 1000000
      : null;

    if (weight <= 0) {
      return res.status(400).json({ success: false, error: 'Weight must be greater than 0.' });
    }

    await pool.request()
      .input('cargoId', sql.Int, cargoId)
      .input('description', sql.NVarChar, description)
      .input('packageCount', sql.Int, packageCount)
      .input('weight', sql.Decimal(18, 3), weight)
      .input('length', sql.Decimal(18, 2), length)
      .input('width', sql.Decimal(18, 2), width)
      .input('height', sql.Decimal(18, 2), height)
      .input('volume', sql.Decimal(18, 3), volume)
      .query(`UPDATE log.ManualCargoItem
              SET Description = @description, PackageCount = @packageCount, Weight = @weight,
                  Length = @length, Width = @width, Height = @height, Volume = @volume
              WHERE CargoID = @cargoId`);

    await recalcManualShipmentTotals(pool, current.ShipmentID);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/manual-cargo/:cargoId', requirePermission('LOG_PLANNING'), async (req, res) => {
  try {
    const cargoId = req.params.cargoId;
    const pool = await getPool();
    const existingResult = await pool.request().input('cargoId', sql.Int, cargoId)
      .query('SELECT ShipmentID FROM log.ManualCargoItem WHERE CargoID = @cargoId');
    const existing = existingResult.recordset[0];
    if (!existing) return res.status(404).json({ success: false, error: 'Cargo line not found.' });

    await pool.request().input('cargoId', sql.Int, cargoId)
      .query('UPDATE log.ManualCargoItem SET Removed = 1 WHERE CargoID = @cargoId');

    await recalcManualShipmentTotals(pool, existing.ShipmentID);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── List every document currently sitting in a shipment's export folder ──────
// Regenerates the packing list first so it's always current, then lists the
// whole folder — an operator-uploaded invoice and a ClearPort customs PDF
// (both written into the same folder by the routes elsewhere in this file)
// show up here too. Backs the "verify documents before booking" popup: KN
// requires invoice + packing list on every shipment, plus a customs
// declaration when customsRequired is set, before a booking is allowed to
// proceed at all.
//
// Registered BEFORE the generic /documents/:fileName route below —
// Express matches routes in registration order, so if that route came
// first, a request for /documents/folder would be caught by it with
// fileName="folder" (failing the .pdf check with a misleading "Only PDF
// documents are available." 400) and this handler would never run at
// all. This bug shipped with the original feature; fixed by reordering.
router.get('/:shipmentId/documents/folder', requirePermission('LOG_PLANNING'), async (req, res) => {
  try {
    const context = await getShipmentContext(req.params.shipmentId);
    await generateShipmentDocuments(context); // refreshes the packing list PDF on disk
    const folder = getShipmentFolderInfo(context.shipment);
    const ref = folder.shipmentRef;

    let entries = [];
    try {
      entries = await fsp.readdir(folder.shipmentPath, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.pdf')) continue;
      const stat = await fsp.stat(path.join(folder.shipmentPath, entry.name));
      files.push({
        fileName: entry.name,
        sizeBytes: stat.size,
        modifiedAtUtc: stat.mtime.toISOString(),
        guessedCategory: guessDocumentCategory(entry.name, ref),
        downloadUrl: `/api/shipmentmain/${req.params.shipmentId}/documents/${encodeURIComponent(entry.name)}`,
      });
    }
    files.sort((a, b) => a.fileName.localeCompare(b.fileName));

    res.json({
      success: true,
      data: {
        shipmentRef: ref,
        customsRequired: toBool(context.shipment.customsRequired),
        customsComplete: toBool(context.shipment.customsComplete),
        files,
      },
    });
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


// ── Operator invoice upload ───────────────────────────────────────
// The commercial invoice is the one document in the trio that's neither
// generated by Nexus (packing list) nor pulled from ClearPort (customs) — an
// operator uploads it by hand once it exists. Body is the raw PDF bytes
// (Content-Type: application/pdf), not multipart — simplest thing that works
// from a plain fetch(..., { body: file }) without adding a new dependency for
// a single-file upload. Saved straight into the same folder the packing list
// and customs PDF already live in.
router.post('/:shipmentId/documents/upload',
  requirePermission('LOG_PLANNING'),
  express.raw({ type: 'application/pdf', limit: '20mb' }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ success: false, error: 'No file content received. Content-Type must be application/pdf.' });
      }
      if (req.body.length > 20 * 1024 * 1024) {
        return res.status(413).json({ success: false, error: 'File is too large (20MB limit).' });
      }

      const context = await getShipmentContext(req.params.shipmentId);
      const folder = await ensureShipmentFolder(context.shipment);
      const ref = folder.shipmentRef;

      const originalName = String(req.get('X-File-Name') || req.query.fileName || 'invoice').replace(/\.pdf$/i, '');
      const fileName = `${ref}-invoice-${sanitizeFileSegment(originalName)}-${Date.now()}.pdf`;
      const filePath = path.join(folder.shipmentPath, fileName);
      await fsp.writeFile(filePath, req.body);

      res.status(201).json({
        success: true,
        data: {
          fileName,
          sizeBytes: req.body.length,
          guessedCategory: 'invoice',
          downloadUrl: `/api/shipmentmain/${req.params.shipmentId}/documents/${encodeURIComponent(fileName)}`,
        },
      });
    } catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
  }
);


// Upload-to-KN moved to routes/freightbooking.js — it's part of the KN
// booking feature (POST /api/freight-booking/:shipmentId/documents/upload-to-kn),
// which also owns the KN OAuth client and the rest of the KN API surface.
// getShipmentContext/getShipmentFolderInfo/writeShipmentEvent below are
// exported (see bottom of file) so that route can still resolve a
// shipment's export folder and log ShipmentEvents without duplicating this
// module's logic.


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
          UPDATE log.ShipmentMain
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


// ── Shipment detail (standard modal) ─────────────────────────────────────────
router.get('/:shipmentId/details', async (req, res) => {
  try {
    const pool = await getPool();
    const shipmentId = Number(req.params.shipmentId);

    const shipmentResult = await pool.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .query(`
        SELECT
          sm.shipmentID,
          sm.originID, sm.originName, sm.originStreet, sm.originCity, sm.originPostCode, sm.originCountry,
          sm.destinationID, sm.destinationName, sm.destinationStreet, sm.destinationCity, sm.destinationPostCode, sm.destinationCountry,
          sm.netWeight, sm.grossWeight, sm.palletCount, sm.shipmentVolume,
          sm.plannedCollection, sm.actualCollection,
          sm.PlannedDelivery  AS plannedDelivery,
          sm.ActualDelivery   AS actualDelivery,
          sm.forwarderID, sm.trackingNumber, sm.incoTerms,
          sm.customsID,
          CAST(ISNULL(sm.IsManual,         0) AS bit) AS isManual,
          CAST(ISNULL(sm.bookingStatus,    0) AS bit) AS bookingStatus,
          CAST(ISNULL(sm.collectionStatus, 0) AS bit) AS collectionStatus,
          CAST(ISNULL(sm.DeliveryStatus,   0) AS bit) AS deliveryStatus,
          CAST(ISNULL(sm.customsRequired,  0) AS bit) AS customsRequired,
          CAST(ISNULL(sm.customsComplete,  0) AS bit) AS customsComplete,
          CAST(ISNULL(sm.shipmentCancelled,0) AS bit) AS shipmentCancelled,
          fa.forwarderName, fa.forwarderMode
        FROM log.ShipmentMain sm
        OUTER APPLY (
          SELECT TOP 1 f.forwarderName, f.forwarderMode FROM log.Forwarders f WHERE f.forwarderID = sm.forwarderID
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
        FROM log.ShipmentLink sl
        INNER JOIN log.DeliveryMain dm ON dm.deliveryID = sl.deliveryID
        LEFT  JOIN log.Destinations d  ON d.destinationID = dm.customerID
        WHERE sl.shipmentID = @shipmentId
        ORDER BY dm.deliveryID ASC`);

    res.json({ success: true, data: { shipment: shipmentResult.recordset[0], deliveries: deliveriesResult.recordset } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});


// ── Toggle customsRequired (blocked if customsComplete) ───────────────────────
router.patch('/:shipmentId/customs-required', requirePermission('LOG_PLANNING'), async (req, res) => {
  try {
    const pool = await getPool();
    const shipmentId = Number(req.params.shipmentId);

    const check = await pool.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .query('SELECT customsComplete FROM log.ShipmentMain WHERE shipmentID = @shipmentId');

    if (!check.recordset.length)
      return res.status(404).json({ success: false, error: 'Shipment not found.' });
    if (toBool(check.recordset[0].customsComplete))
      return res.status(400).json({ success: false, error: 'Customs is already complete and cannot be changed.' });

    await pool.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .input('required', sql.Bit, toBool(req.body.required) ? 1 : 0)
      .query(`UPDATE log.ShipmentMain SET customsRequired = @required
              WHERE shipmentID = @shipmentId AND ISNULL(customsComplete, 0) = 0`);
    stampDbChange(req.session?.user?.username, 'ShipmentMain');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});


// ── Bulk toggle customsRequired — mass "mark as no customs required" from
// the Customs Documents queue, so several shipments that don't actually
// need a declaration (e.g. wrongly flagged, or a destination/incoterms
// change) can be cleared in one go instead of one at a time. Same
// customsComplete guard as the single-shipment route above: any shipment
// whose customs is already complete is left untouched and reported back
// in `skipped` rather than failing the whole batch.
router.patch('/customs-required/bulk', requirePermission('LOG_PLANNING'), async (req, res) => {
  const shipmentIds = normalizeIdList(req.body.shipmentIDs);
  if (!shipmentIds.length) {
    return res.status(400).json({ success: false, error: 'Select at least one shipment.' });
  }
  const required = toBool(req.body.required) ? 1 : 0;

  try {
    const pool = await getPool();

    const blockedRequest = pool.request();
    const blockedClause = createInClause(blockedRequest, shipmentIds, 'bsid');
    const blockedRes = await blockedRequest.query(`
      SELECT shipmentID FROM log.ShipmentMain
      WHERE shipmentID IN (${blockedClause}) AND ISNULL(customsComplete, 0) = 1`);
    const skipped = blockedRes.recordset.map(r => r.shipmentID);

    const updateRequest = pool.request();
    const updateClause = createInClause(updateRequest, shipmentIds, 'usid');
    updateRequest.input('required', sql.Bit, required);
    const result = await updateRequest.query(`
      UPDATE log.ShipmentMain
      SET customsRequired = @required
      WHERE shipmentID IN (${updateClause})
        AND ISNULL(customsComplete, 0) = 0;

      SELECT @@ROWCOUNT AS affectedRows;
    `);

    stampDbChange(req.session?.user?.username, 'ShipmentMain');
    res.json({ success: true, data: { updated: Number(result.recordset[0]?.affectedRows || 0), skipped } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── Remove a delivery from a shipment ────────────────────────────────────────
router.delete('/:shipmentId/deliveries/:deliveryId', requirePermission('LOG_PLANNING'), async (req, res) => {
  try {
    const pool = await getPool();
    const shipmentId = Number(req.params.shipmentId);
    const deliveryId = Number(req.params.deliveryId);

    await pool.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .input('deliveryId', sql.BigInt, deliveryId)
      .query('DELETE FROM log.ShipmentLink WHERE shipmentID = @shipmentId AND deliveryID = @deliveryId');

    const remaining = await pool.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .query('SELECT COUNT(*) AS cnt FROM log.ShipmentLink WHERE shipmentID = @shipmentId');

    if (remaining.recordset[0].cnt === 0) {
      await pool.request()
        .input('shipmentId', sql.BigInt, shipmentId)
        .query('UPDATE log.ShipmentMain SET shipmentCancelled = 1 WHERE shipmentID = @shipmentId');
      return res.json({ success: true, data: { cancelled: true } });
    }

    await syncShipmentAggregateData(shipmentId);
    res.json({ success: true, data: { cancelled: false } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});


// ── Add deliveries to an existing shipment ────────────────────────────────────
router.post('/:shipmentId/deliveries', requirePermission('LOG_PLANNING'), async (req, res) => {
  try {
    const pool = await getPool();
    const shipmentId = Number(req.params.shipmentId);
    const deliveryIDs = normalizeDeliveryIds(req.body.deliveryIDs);

    if (!deliveryIDs.length)
      return res.status(400).json({ success: false, error: 'No delivery IDs provided.' });

    const shipmentResult = await pool.request()
      .input('shipmentId', sql.BigInt, shipmentId)
      .query('SELECT destinationID, incoTerms FROM log.ShipmentMain WHERE shipmentID = @shipmentId AND ISNULL(shipmentCancelled, 0) = 0');

    if (!shipmentResult.recordset.length)
      return res.status(404).json({ success: false, error: 'Shipment not found or cancelled.' });

    const { destinationID: customerId, incoTerms: shipmentIncoTerms } = shipmentResult.recordset[0];

    const req2 = pool.request();
    const inClause = createInClause(req2, deliveryIDs, 'deliveryId');
    const available = await req2.query(`
      SELECT dm.deliveryID, dm.customerID, dm.incoterms, d.defaultIncoterms
      FROM log.DeliveryMain dm
      LEFT JOIN log.Destinations d ON d.destinationID = dm.customerID
      LEFT JOIN log.ShipmentLink sl ON sl.deliveryID = dm.deliveryID
      WHERE dm.deliveryID IN (${inClause})
        AND dm.completionStatus = 1
        AND ISNULL(dm.deliveryCancelled, 0) = 0
        AND ISNULL(dm.pendingPackagingData, 0) = 0
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
        .query('INSERT INTO log.ShipmentLink (shipmentID, deliveryID) VALUES (@shipmentId, @deliveryId)');
    }

    await syncShipmentAggregateData(shipmentId);
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
});


// ── Update haulier ────────────────────────────────────────────────────────────
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
      `UPDATE log.ShipmentMain SET ${sets.join(', ')} WHERE shipmentID = @shipmentId`
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
      .query(`UPDATE log.ShipmentMain SET forwarderID = @forwarderId
              WHERE shipmentID = @shipmentId AND ISNULL(shipmentCancelled, 0) = 0`);

    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});


// ── Shipment search — outbound + inbound combined ───────────────────────────
// Query params: shipmentRef, deliveryNumber, forwarder, customer, tracking,
//               dateField (plannedCollection|actualCollection|plannedDelivery|actualDelivery),
//               dateFrom, dateTo
//
// Runs two separate queries (outbound against log.ShipmentMain,
// inbound against log.PurchaseOrderShipment) rather than one SQL UNION ALL —
// the two tables' ID spaces can numerically collide (see other direction-
// tagged code in this app) and their column types/shapes differ enough
// (incoTerms, booking/collection/delivery bit flags, delivery numbers) that
// combining in JS after the fact is clearer than coercing both into one
// SELECT list. Each leg only runs if at least one filter actually applies to
// it, so a search that only makes sense for one direction (e.g. deliveryNumber,
// which is an outbound-only concept) doesn't fall through to returning every
// row on the other side. Results are merged and re-sorted by whichever date
// is most relevant to each row (delivered > planned delivery > collected >
// planned collection), most recent first.
router.get('/search', async (req, res) => {
  const { shipmentRef, deliveryNumber, forwarder, customer, tracking, dateField, dateFrom, dateTo } = req.query;

  const OUT_DATE_COLS = {
    plannedCollection: 'sm.plannedCollection',
    actualCollection:  'sm.actualCollection',
    plannedDelivery:   'sm.plannedDelivery',
    actualDelivery:    'sm.actualDelivery',
  };
  // Inbound has no distinct "actual collection" field — DispatchDate is set
  // once at shipment creation and doubles as the planned collection date, so
  // an actualCollection search only ever matches outbound rows.
  const IN_DATE_COLS = {
    plannedCollection: 'ps.DispatchDate',
    actualCollection:  null,
    plannedDelivery:   'ps.ExpectedEta',
    actualDelivery:    'ps.ReceivedAtUtc',
  };

  try {
    const pool = await getPool();

    // ── Outbound leg ──
    const outReq   = pool.request();
    const outWhere = [`ISNULL(sm.shipmentCancelled, 0) = 0`];

    if (shipmentRef?.trim()) {
      const ref = parseInt(shipmentRef.trim(), 10);
      if (!isNaN(ref)) { outReq.input('shipmentRef', sql.BigInt, ref); outWhere.push('sm.shipmentID = @shipmentRef'); }
    }
    if (customer?.trim()) {
      outReq.input('customer', sql.NVarChar, `%${customer.trim()}%`);
      outWhere.push('sm.destinationName LIKE @customer');
    }
    if (forwarder?.trim()) {
      outReq.input('forwarder', sql.NVarChar, `%${forwarder.trim()}%`);
      outWhere.push(`EXISTS (
        SELECT 1 FROM log.Forwarders f
        WHERE f.forwarderID = sm.forwarderID AND f.forwarderName LIKE @forwarder
      )`);
    }
    if (tracking?.trim()) {
      outReq.input('tracking', sql.NVarChar, `%${tracking.trim()}%`);
      outWhere.push('sm.trackingNumber LIKE @tracking');
    }
    if (deliveryNumber?.trim()) {
      const dn = parseInt(deliveryNumber.trim(), 10);
      if (!isNaN(dn)) {
        outReq.input('deliveryNumber', sql.BigInt, dn);
        outWhere.push(`EXISTS (
          SELECT 1 FROM log.ShipmentLink sl
          WHERE sl.shipmentID = sm.shipmentID AND sl.deliveryID = @deliveryNumber
        )`);
      }
    }
    const outDateCol = OUT_DATE_COLS[dateField];
    if (outDateCol) {
      if (dateFrom?.trim()) { outReq.input('dateFrom', sql.DateTime, new Date(dateFrom)); outWhere.push(`${outDateCol} >= @dateFrom`); }
      if (dateTo?.trim())   { outReq.input('dateTo',   sql.DateTime, new Date(dateTo));   outWhere.push(`${outDateCol} <= @dateTo`); }
    }

    // ── Inbound leg ──
    const inReq   = pool.request();
    const inWhere = [`ps.CancelledAtUtc IS NULL`];

    if (shipmentRef?.trim()) {
      const refText = shipmentRef.trim();
      const refNum  = parseInt(refText, 10);
      const parts   = [];
      if (!isNaN(refNum)) { inReq.input('shipmentRefNum', sql.Int, refNum); parts.push('ps.ShipmentId = @shipmentRefNum'); }
      inReq.input('shipmentRefText', sql.NVarChar, `%${refText}%`);
      parts.push('ps.ShipmentReference LIKE @shipmentRefText');
      inWhere.push(`(${parts.join(' OR ')})`);
    }
    if (customer?.trim()) {
      inReq.input('customer', sql.NVarChar, `%${customer.trim()}%`);
      inWhere.push(`(
        ISNULL(ps.OriginName, '') LIKE @customer
        OR EXISTS (
          SELECT 1 FROM log.PurchaseOrderSuggestion p2
          JOIN log.Vendor v ON v.VendorId = p2.VendorId
          WHERE p2.ShipmentId = ps.ShipmentId AND v.VendorName LIKE @customer
        )
      )`);
    }
    if (forwarder?.trim()) {
      inReq.input('forwarder', sql.NVarChar, `%${forwarder.trim()}%`);
      inWhere.push(`(
        EXISTS (SELECT 1 FROM log.Forwarders f WHERE f.forwarderID = ps.ForwarderID AND f.forwarderName LIKE @forwarder)
        OR ps.Haulier LIKE @forwarder
      )`);
    }
    if (tracking?.trim()) {
      inReq.input('tracking', sql.NVarChar, `%${tracking.trim()}%`);
      inWhere.push('ps.TrackingNumber LIKE @tracking');
    }
    if (deliveryNumber?.trim()) {
      // Outbound-only concept — see comment above the route.
      inWhere.push('1 = 0');
    }
    const inDateCol = IN_DATE_COLS[dateField];
    if (dateField && !inDateCol) {
      inWhere.push('1 = 0');
    } else if (inDateCol) {
      if (dateFrom?.trim()) { inReq.input('dateFrom', sql.DateTime, new Date(dateFrom)); inWhere.push(`${inDateCol} >= @dateFrom`); }
      if (dateTo?.trim())   { inReq.input('dateTo',   sql.DateTime, new Date(dateTo));   inWhere.push(`${inDateCol} <= @dateTo`); }
    }

    const outActive = outWhere.length > 1;
    const inActive  = inWhere.length > 1;

    if (!outActive && !inActive) {
      return res.status(400).json({ success: false, error: 'Please provide at least one search term.' });
    }

    const results = [];

    if (outActive) {
      const outResult = await outReq.query(`
        SELECT
          sm.shipmentID,
          sm.destinationName,
          sm.plannedCollection,
          sm.actualCollection,
          sm.PlannedDelivery    AS plannedDelivery,
          sm.ActualDelivery     AS actualDelivery,
          sm.trackingNumber,
          sm.incoTerms,
          sm.forwarderID,
          CAST(ISNULL(sm.bookingStatus,    0) AS bit) AS bookingStatus,
          CAST(ISNULL(sm.collectionStatus, 0) AS bit) AS collectionStatus,
          CAST(ISNULL(sm.DeliveryStatus,   0) AS bit) AS deliveryStatus,
          CAST(ISNULL(sm.shipmentCancelled,0) AS bit) AS shipmentCancelled,
          (SELECT TOP 1 f.forwarderName FROM log.Forwarders f WHERE f.forwarderID = sm.forwarderID) AS forwarderName
        FROM log.ShipmentMain sm
        WHERE ${outWhere.join(' AND ')}
        ORDER BY sm.shipmentID DESC`);

      for (const r of outResult.recordset) {
        results.push({
          key:               `O:${r.shipmentID}`,
          direction:         'outbound',
          shipmentID:        r.shipmentID,
          refDisplay:        String(r.shipmentID).padStart(8, '0'),
          customer:          r.destinationName,
          forwarderName:     r.forwarderName,
          incoTerms:         r.incoTerms,
          plannedCollection: r.plannedCollection,
          actualCollection:  r.actualCollection,
          plannedDelivery:   r.plannedDelivery,
          actualDelivery:    r.actualDelivery,
          trackingNumber:    r.trackingNumber,
          bookingStatus:     r.bookingStatus,
          collectionStatus:  r.collectionStatus,
          deliveryStatus:    r.deliveryStatus,
          shipmentCancelled: r.shipmentCancelled,
          sortDate: r.actualDelivery || r.plannedDelivery || r.actualCollection || r.plannedCollection || null,
        });
      }
    }

    if (inActive) {
      const inResult = await inReq.query(`
        SELECT
          ps.ShipmentId, ps.ShipmentReference, ps.DispatchDate, ps.ExpectedEta,
          ps.Haulier, ps.ForwarderID, ps.TrackingNumber, ps.ReceivedAtUtc, ps.IsManual, ps.OriginName,
          (SELECT TOP 1 f.forwarderName FROM log.Forwarders f WHERE f.forwarderID = ps.ForwarderID) AS forwarderNameLookup,
          STUFF((
            SELECT DISTINCT ', ' + v.VendorName
            FROM log.PurchaseOrderSuggestion p2
            JOIN log.Vendor v ON v.VendorId = p2.VendorId
            WHERE p2.ShipmentId = ps.ShipmentId
            FOR XML PATH('')
          ), 1, 2, '') AS Suppliers
        FROM log.PurchaseOrderShipment ps
        WHERE ${inWhere.join(' AND ')}
        ORDER BY ps.CreatedAtUtc DESC`);

      for (const r of inResult.recordset) {
        results.push({
          key:               `I:${r.ShipmentId}`,
          direction:         'inbound',
          shipmentID:        r.ShipmentId,
          refDisplay:        r.ShipmentReference || `#${r.ShipmentId}`,
          customer:          r.IsManual ? `Manual — ${r.OriginName || 'no origin'}` : (r.Suppliers || '—'),
          forwarderName:     r.forwarderNameLookup || r.Haulier,
          incoTerms:         null,
          plannedCollection: r.DispatchDate,
          actualCollection:  null,
          plannedDelivery:   r.ExpectedEta,
          actualDelivery:    r.ReceivedAtUtc,
          trackingNumber:    r.TrackingNumber,
          receivedAtUtc:     r.ReceivedAtUtc,
          sortDate: r.ReceivedAtUtc || r.ExpectedEta || r.DispatchDate || null,
        });
      }
    }

    results.sort((a, b) => {
      const ta = a.sortDate ? new Date(a.sortDate).getTime() : 0;
      const tb = b.sortDate ? new Date(b.sortDate).getTime() : 0;
      return tb - ta;
    });

    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── Events for a shipment ─────────────────────────────────────────────────────
router.get('/:shipmentId/events', async (req, res) => {
  try {
    const pool   = await getPool();
    const result = await pool.request()
      .input('shipmentId', sql.BigInt, req.params.shipmentId)
      .query(`SELECT EventID, shipmentID, eventCategory, eventDescription, timeStamp
              FROM log.ShipmentEvents
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
    const result = await pool.request().input('shipmentId', sql.BigInt, req.params.shipmentId).query('SELECT * FROM log.ShipmentMain WHERE shipmentID = @shipmentId'); 
    res.json(result.recordset); }
  catch (err) { res.status(500).json({ error: err.message }); }
});


router.get('/forwarder/:forwarderId', async (req, res) => {
  try { 
    const pool = await getPool(); 
    const result = await pool.request().input('forwarderId', sql.BigInt, req.params.forwarderId).query('SELECT * FROM log.ShipmentMain WHERE forwarderID = @forwarderId'); 
    res.json(result.recordset); }
  catch (err) { res.status(500).json({ error: err.message }); }
});


router.get('/destination/:destinationId', async (req, res) => {
  try { 
    const pool = await getPool(); 
    const result = await pool.request().input('destinationId', sql.BigInt, req.params.destinationId).query('SELECT * FROM log.ShipmentMain WHERE destinationID = @destinationId'); 
    res.json(result.recordset); }
  catch (err) { res.status(500).json({ error: err.message }); }
});


router.get('/daterange', async (req, res) => {
  try { 
    const { dateFrom, dateTo } = req.query; 
    const pool = await getPool(); 
    const result = await pool.request().input('dateFrom', sql.DateTime, new Date(dateFrom)).input('dateTo', sql.DateTime, new Date(dateTo)).query('SELECT * FROM log.ShipmentMain WHERE plannedCollection BETWEEN @dateFrom AND @dateTo'); 
    res.json(result.recordset); }
  catch (err) { res.status(500).json({ error: err.message }); }
});


router.post('/', async (req, res) => {
  try {
    const { originID, originName, originStreet, originCity, originPostCode, originCountry, destinationID, destinationName, destinationStreet, destinationCity, destinationPostCode, destinationCountry, netWeight, grossWeight, palletCount, shipmentVolume, plannedCollection, actualCollection, collectionStatus, forwarderID, trackingNumber, incoTerms, customsRequired, customsComplete, shipmentCancelled } = req.body;
    const pool = await getPool();
    const result = await pool.request().input('originID', sql.BigInt, originID).input('originName', sql.NVarChar, originName).input('originStreet', sql.NVarChar, originStreet).input('originCity', sql.NVarChar, originCity).input('originPostCode', sql.NVarChar, originPostCode).input('originCountry', sql.NVarChar, originCountry).input('destinationID', sql.BigInt, destinationID).input('destinationName', sql.NVarChar, destinationName).input('destinationStreet', sql.NVarChar, destinationStreet).input('destinationCity', sql.NVarChar, destinationCity).input('destinationPostCode', sql.NVarChar, destinationPostCode).input('destinationCountry', sql.NVarChar, destinationCountry).input('netWeight', sql.Decimal, netWeight).input('grossWeight', sql.Decimal, grossWeight).input('palletCount', sql.BigInt, palletCount).input('shipmentVolume', sql.Decimal, shipmentVolume).input('plannedCollection', sql.DateTime, plannedCollection ? new Date(plannedCollection) : null).input('actualCollection', sql.DateTime, actualCollection ? new Date(actualCollection) : null).input('collectionStatus', sql.Bit, collectionStatus).input('forwarderID', sql.BigInt, forwarderID).input('trackingNumber', sql.NVarChar, trackingNumber).input('incoTerms', sql.NVarChar, incoTerms).input('customsRequired', sql.Bit, customsRequired).input('customsComplete', sql.Bit, customsComplete).input('shipmentCancelled', sql.Bit, shipmentCancelled).query(`INSERT INTO log.ShipmentMain (originID, originName, originStreet, originCity, originPostCode, originCountry, destinationID, destinationName, destinationStreet, destinationCity, destinationPostCode, destinationCountry, netWeight, grossWeight, palletCount, shipmentVolume, plannedCollection, actualCollection, collectionStatus, forwarderID, trackingNumber, incoTerms, customsRequired, customsComplete, shipmentCancelled) VALUES (@originID, @originName, @originStreet, @originCity, @originPostCode, @originCountry, @destinationID, @destinationName, @destinationStreet, @destinationCity, @destinationPostCode, @destinationCountry, @netWeight, @grossWeight, @palletCount, @shipmentVolume, @plannedCollection, @actualCollection, @collectionStatus, @forwarderID, @trackingNumber, @incoTerms, @customsRequired, @customsComplete, @shipmentCancelled); SELECT SCOPE_IDENTITY() AS shipmentID;`);
    res.status(201).json({ message: 'Record created successfully', shipmentID: result.recordset[0].shipmentID });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Named exports for routes/freightbooking.js — it owns the KN
// booking/upload-to-kn feature but reuses this module's shipment context,
// export-folder resolution, and event log rather than duplicating them.
export { getShipmentContext, getShipmentFolderInfo, writeShipmentEvent };

export default router;
