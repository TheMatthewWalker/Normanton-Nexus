// routes/customsreport.js parses an uploaded Shipments-style xlsx, enriches
// it via direct axios calls to SapServer's /api/customs/* endpoints (own
// makeSapToken/sapAgent boilerplate, same pattern as routes/consignment.js —
// NOT a loopback fetch to this app's own /api/sap/* proxy routes, which
// don't work: this app only listens on 443/80, nothing on process.env.PORT),
// resolves VAT/HS fallback lookups via mssql, apportions weight, and streams
// back a finished .xlsx. Covers: missing-file/missing-column 400s,
// permission gating, the happy path (parsed back from the returned buffer),
// a delivery absent from SAP surfacing as a Warnings-sheet row instead of
// failing the whole request, the zero-LIPS 422 (including a failed-round
// reason in the message, not just "no data"), and the consignment
// (no-invoice) pricing fallback.

import { describe, test, expect, beforeAll, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const axiosMock = { get: jest.fn(), post: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const customsUser = { ...operatorUser, permissions: ['LOG_CUSTOMS_REPORT'] };

let customsReportRouter;
let app;
let appNoPermission;

beforeAll(async () => {
  ({ default: customsReportRouter } = await import('../../routes/customsreport.js'));
  app = buildTestApp(customsReportRouter, { sessionUser: customsUser });
  appNoPermission = buildTestApp(customsReportRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  dbRequest.query.mockResolvedValue({ recordset: [] }); // VAT/HS lookups + audit inserts default to "nothing found" / succeed
  axiosMock.get.mockReset();
  axiosMock.post.mockReset();
  axiosMock.post.mockImplementation(async () => ({ data: { success: true, data: [] } }));
});

// supertest/superagent has no built-in parser for the xlsx MIME type, so a
// raw-binary response would otherwise come back as an empty res.body — this
// collects the response as a Buffer so ExcelJS can load it back.
function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', chunk => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

async function postUpload(app, buffer) {
  return request(app)
    .post('/generate')
    .set('Content-Type', XLSX_TYPE)
    .buffer()
    .parse(binaryParser)
    .send(Buffer.from(buffer));
}

async function buildShipmentsUpload(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Shipments');
  ws.addRow(['PicksheetNumber', 'ShipmentRef', 'ActualCollectionDate', 'TotalWeight']);
  for (const r of rows) ws.addRow(r);
  return wb.xlsx.writeBuffer();
}

function mockSapFetch(responsesByPath) {
  axiosMock.post.mockImplementation(async (url) => {
    const match = Object.keys(responsesByPath).find(p => url.endsWith(p));
    const data = match ? responsesByPath[match] : [];
    return { data: { success: true, data } };
  });
}

async function loadWorkbookFromResponse(res) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body);
  return wb;
}

describe('POST /generate — validation', () => {
  test('400s with no file content', async () => {
    const res = await request(app).post('/generate').set('Content-Type', XLSX_TYPE).send();
    expect(res.status).toBe(400);
  });

  test('400s when the upload is missing an expected column', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Shipments');
    ws.addRow(['PicksheetNumber', 'ShipmentRef']); // missing ActualCollectionDate/TotalWeight
    ws.addRow(['82892007', '14781']);
    const buffer = await wb.xlsx.writeBuffer();

    const res = await request(app).post('/generate').set('Content-Type', XLSX_TYPE).send(Buffer.from(buffer));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/ActualCollectionDate/);
  });

  test('400s when the upload has a header row but no data rows', async () => {
    const buffer = await buildShipmentsUpload([]);
    const res = await request(app).post('/generate').set('Content-Type', XLSX_TYPE).send(Buffer.from(buffer));
    expect(res.status).toBe(400);
  });

  test('403s without LOG_CUSTOMS_REPORT', async () => {
    const buffer = await buildShipmentsUpload([['82892007', '14781', new Date(2026, 4, 15), 45]]);
    const res = await request(appNoPermission).post('/generate').set('Content-Type', XLSX_TYPE).send(Buffer.from(buffer));
    expect(res.status).toBe(403);
  });
});

describe('POST /generate — SAP failure modes', () => {
  test('422s when SAP returns no LIPS rows for any uploaded delivery', async () => {
    mockSapFetch({}); // every SAP endpoint returns []
    const buffer = await buildShipmentsUpload([['82892007', '14781', new Date(2026, 4, 15), 45]]);
    const res = await request(app).post('/generate').set('Content-Type', XLSX_TYPE).send(Buffer.from(buffer));
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/no delivery line items/i);
  });

  // Locks in the fix for a real production bug: a hard failure of the LIPS/
  // LIKP call (network error, auth failure, SapServer down) used to be
  // indistinguishable from "SAP genuinely has no data for these deliveries"
  // — both collapsed into the same generic 422, hiding the real cause. The
  // message must now include why the round failed.
  test('422 message includes the underlying failure reason when the SAP call itself errors, not just "no data"', async () => {
    axiosMock.post.mockRejectedValue(new Error('Request failed with status code 401'));
    const buffer = await buildShipmentsUpload([['82892007', '14781', new Date(2026, 4, 15), 45]]);
    const res = await request(app).post('/generate').set('Content-Type', XLSX_TYPE).send(Buffer.from(buffer));
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/LIPS query failed: Request failed with status code 401/);
  });
});

describe('POST /generate — happy path', () => {
  test('builds a CUSTOMS-format report row from a fully-enriched delivery', async () => {
    // Quantity/statisticalValue/invoiceDate deliberately use SAP's real
    // RFC_READ_TABLE output format (European-grouped numbers, DD.MM.YYYY
    // dates — confirmed against a live response) rather than plain values,
    // so this test exercises the actual parsing bug that shipped and was
    // then fixed (parseSapNumber/parseSapDate), not just the happy case.
    mockSapFetch({
      '/api/customs/lips': [{ deliveryNumber: '0082892007', itemNumber: '000010', materialNumber: 'CP1166', quantity: '2.200,000' }],
      '/api/customs/likp': [{ deliveryNumber: '0082892007', incoterms: 'DDP', consigneeCode: '0000363533' }],
      '/api/customs/vbfa': [{ deliveryNumber: '0082892007', itemNumber: '000010', invoiceNumber: '0006123356', invoiceItem: '000010', statisticalValue: '594,00', invoiceDate: '10.05.2026' }],
      '/api/customs/marc': [{ materialNumber: 'CP1166', commodityCode: '39173900', countryOfOrigin: 'GB' }],
      '/api/customs/kna1': [{ customerCode: '0000363533', name: 'Imperial auto Slovakia S.R.O', vatNumber: 'SK2120170316', destinationCountry: 'SK' }],
      '/api/customs/vbrk': [{ invoiceNumber: '0006123356', currency: 'EUR' }],
    });
    dbRequest.query.mockResolvedValue({ recordset: [{ Description: 'PTFE Hose with Stainless Steel Braiding' }] });

    const buffer = await buildShipmentsUpload([['82892007', '14781', new Date(2026, 4, 15), 45]]);
    const res = await postUpload(app, buffer);

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);

    const wb = await loadWorkbookFromResponse(res);
    const ws = wb.getWorksheet('CUSTOMS');
    const header = ws.getRow(1).values.slice(1);
    expect(header).toEqual([
      'Delivery Number', 'Delivery Item', 'Material', 'Quantity', 'Invoice Number', 'Currency',
      'Sales Value', 'Commodity Code', 'Country of Origin', 'Incoterms', 'Consignee Code', 'Name',
      'HS Description', 'VAT No.', 'Shipment Ref', 'Invoice Date', 'Shipment Date', 'Weight',
    ]);

    const dataRow = ws.getRow(2).values.slice(1);
    expect(dataRow[0]).toBe('82892007');   // Delivery Number, zero-padding stripped
    expect(dataRow[1]).toBe('10');          // Delivery Item
    expect(dataRow[2]).toBe('CP1166');      // Material
    expect(dataRow[3]).toBe(2200);          // Quantity
    expect(dataRow[4]).toBe('6123356');     // Invoice Number
    expect(dataRow[5]).toBe('EUR');         // Currency
    expect(dataRow[6]).toBe(594);           // Sales Value
    expect(dataRow[7]).toBe('39173900');    // Commodity Code
    expect(dataRow[8]).toBe('GB');          // Country of Origin
    expect(dataRow[9]).toBe('DDP');         // Incoterms
    expect(dataRow[10]).toBe('363533');     // Consignee Code
    expect(dataRow[11]).toBe('Imperial auto Slovakia S.R.O'); // Name
    expect(dataRow[12]).toBe('PTFE Hose with Stainless Steel Braiding'); // HS Description
    expect(dataRow[13]).toBe('SK2120170316'); // VAT No. (from SAP KNA1, no override lookup needed)
    expect(dataRow[14]).toBe('14781');      // Shipment Ref
    expect(dataRow[15]).toEqual(new Date(2026, 4, 10)); // Invoice Date — from VBFA.ERDAT, not VBRK
    expect(dataRow[17]).toBe(45);           // Weight — single line, full weight

    // No Warnings sheet when every delivery in the upload was found in SAP.
    expect(wb.getWorksheet('Warnings')).toBeUndefined();
  });

  test('splits weight across two line items of the same delivery by quantity share', async () => {
    // Quantities in SAP's real European-grouped format (e.g. "1.113,000")
    // rather than plain digits — this is the exact scenario that shipped
    // broken: NaN quantities summed to a zero totalQty, blanking weight on
    // every line.
    mockSapFetch({
      '/api/customs/lips': [
        { deliveryNumber: '0082888744', itemNumber: '000010', materialNumber: 'TSSV16-6B01', quantity: '113,000' },
        { deliveryNumber: '0082888744', itemNumber: '000020', materialNumber: 'TCEV9-5B01', quantity: '217,000' },
      ],
      '/api/customs/likp': [{ deliveryNumber: '0082888744', incoterms: 'DDP', consigneeCode: '0000363771' }],
    });

    const buffer = await buildShipmentsUpload([['82888744', '14875', new Date(2026, 4, 22), 127]]);
    const res = await postUpload(app, buffer);

    expect(res.status).toBe(200);
    const wb = await loadWorkbookFromResponse(res);
    const ws = wb.getWorksheet('CUSTOMS');
    expect(ws.getRow(2).getCell(18).value).toBe(43.49);
    expect(ws.getRow(3).getCell(18).value).toBe(83.51);
  });

  test('a delivery in the upload with no SAP match is warned about, not silently dropped', async () => {
    mockSapFetch({
      '/api/customs/lips': [{ deliveryNumber: '0082892007', itemNumber: '000010', materialNumber: 'CP1166', quantity: '2200' }],
      '/api/customs/likp': [{ deliveryNumber: '0082892007', incoterms: 'DDP', consigneeCode: '0000363533' }],
    });

    const buffer = await buildShipmentsUpload([
      ['82892007', '14781', new Date(2026, 4, 15), 45],
      ['99999999', '14999', new Date(2026, 4, 16), 10], // no matching LIPS row
    ]);
    const res = await postUpload(app, buffer);

    expect(res.status).toBe(200);
    const wb = await loadWorkbookFromResponse(res);
    const warnWs = wb.getWorksheet('Warnings');
    expect(warnWs).toBeDefined();
    expect(warnWs.getRow(2).getCell(1).value).toMatch(/99999999/);
  });
});

describe('POST /generate — consignment (no-invoice) fallback', () => {
  test('uses the delivery number as invoice number and prices from A005/KONP when VBFA has nothing', async () => {
    mockSapFetch({
      '/api/customs/lips': [{ deliveryNumber: '0082900001', itemNumber: '000010', materialNumber: 'CP1166', quantity: '100' }],
      '/api/customs/likp': [{ deliveryNumber: '0082900001', incoterms: 'DDP', consigneeCode: '0000363533', goodsIssueDate: '18.05.2026' }],
      '/api/customs/vbfa': [], // no billing document — consignment shipment
      '/api/customs/marc': [{ materialNumber: 'CP1166', commodityCode: '39173900', countryOfOrigin: 'GB' }],
      '/api/customs/kna1': [{ customerCode: '0000363533', name: 'Imperial auto Slovakia S.R.O', vatNumber: 'SK2120170316', destinationCountry: 'SK' }],
      '/api/customs/consignment-price': [{ customerCode: '0000363533', materialNumber: 'CP1166', rate: '12,50', currency: 'EUR', pricingUnit: '1' }],
    });

    const buffer = await buildShipmentsUpload([['82900001', '15000', new Date(2026, 4, 20), 20]]);
    const res = await postUpload(app, buffer);

    expect(res.status).toBe(200);
    const wb = await loadWorkbookFromResponse(res);
    const dataRow = wb.getWorksheet('CUSTOMS').getRow(2).values.slice(1);
    expect(dataRow[4]).toBe('82900001'); // Invoice Number — placeholder = delivery number
    expect(dataRow[5]).toBe('EUR');      // Currency, from the condition record
    expect(dataRow[6]).toBe(1250);       // Sales Value = 12.50 / 1 * 100
    // Invoice Date — falls back to LIKP's goods issue date (WADAT_IST),
    // since a consignment shipment has no real invoice/ERDAT to source one from.
    expect(dataRow[15]).toEqual(new Date(2026, 4, 18));
  });

  test('leaves Invoice Date blank when LIKP itself has no goods issue date either', async () => {
    mockSapFetch({
      '/api/customs/lips': [{ deliveryNumber: '0082900003', itemNumber: '000010', materialNumber: 'CP1166', quantity: '100' }],
      '/api/customs/likp': [{ deliveryNumber: '0082900003', incoterms: 'DDP', consigneeCode: '0000363533' }], // no goodsIssueDate
      '/api/customs/vbfa': [],
      '/api/customs/consignment-price': [{ customerCode: '0000363533', materialNumber: 'CP1166', rate: '12,50', currency: 'EUR', pricingUnit: '1' }],
    });

    const buffer = await buildShipmentsUpload([['82900003', '15003', new Date(2026, 4, 20), 20]]);
    const res = await postUpload(app, buffer);

    expect(res.status).toBe(200);
    const wb = await loadWorkbookFromResponse(res);
    const dataRow = wb.getWorksheet('CUSTOMS').getRow(2).values.slice(1);
    expect(dataRow[15]).toBe('');
  });

  test('warns (but does not fail) when neither an invoice nor a consignment price is found', async () => {
    mockSapFetch({
      '/api/customs/lips': [{ deliveryNumber: '0082900002', itemNumber: '000010', materialNumber: 'CP1166', quantity: '50' }],
      '/api/customs/likp': [{ deliveryNumber: '0082900002', incoterms: 'DDP', consigneeCode: '0000363533' }],
      '/api/customs/vbfa': [],
      '/api/customs/consignment-price': [], // no condition record either
    });

    const buffer = await buildShipmentsUpload([['82900002', '15001', new Date(2026, 4, 21), 5]]);
    const res = await postUpload(app, buffer);

    expect(res.status).toBe(200);
    const wb = await loadWorkbookFromResponse(res);
    const dataRow = wb.getWorksheet('CUSTOMS').getRow(2).values.slice(1);
    // Invoice Number is still the delivery number placeholder even when no
    // consignment price is found — only the value/currency stay blank.
    expect(dataRow[4]).toBe('82900002');
    expect(dataRow[5]).toBe('');   // Currency — blank, no price found
    expect(dataRow[6]).toBe(''); // Sales Value — blank, no price found

    const warnWs = wb.getWorksheet('Warnings');
    expect(warnWs).toBeDefined();
    expect(warnWs.getRow(2).getCell(1).value).toMatch(/no invoice and no consignment price/i);
  });
});
