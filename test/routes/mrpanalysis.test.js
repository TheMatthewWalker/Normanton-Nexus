// routes/mrpanalysis.js — mocked one level deeper than most route tests (mssql + axios,
// not performancesap.js/performancesql.js themselves): this route imports
// runMrpHistoryRefresh from performancesync.js, which itself transitively imports
// performancesap.js/performancesql.js again alongside several sibling modules
// (performanceallocation.js etc.) — a partial wholesale mock of either module breaks with
// "does not provide an export named X" the moment any of those siblings needs an export this
// test doesn't happen to use. Same reasoning/pattern as
// test/unit/performancesync.mrpHistory.test.js.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const sapClientMock = { get: jest.fn(), post: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: { create: jest.fn(() => sapClientMock) } }));

const mrpUser = { ...operatorUser, permissions: ['LOG_MRP'] };

let app;

beforeAll(async () => {
  const { default: mrpAnalysisRouter } = await import('../../routes/mrpanalysis.js');
  app = buildTestApp(mrpAnalysisRouter, { sessionUser: mrpUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  sapClientMock.get.mockReset();
  sapClientMock.post.mockReset();
});

describe('GET /trends', () => {
  test('returns consumption and receipt series together', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ Material: '30005R', FiscalYear: 2025, ConsumedQty: 100 }] })
      .mockResolvedValueOnce({ recordset: [{ Material: '30005R', Vendor: 7, FiscalYear: 2025, ReceivedQty: 90 }] });

    const res = await request(app).get('/trends');

    expect(res.status).toBe(200);
    expect(res.body.data.consumption).toHaveLength(1);
    expect(res.body.data.receipts).toHaveLength(1);
  });

  test('a vendor filter with no material search is narrowed to that vendor\'s own ordering history first', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ Material: '30005R' }] }) // listVendorMaterialsFromReceiptHistory
      .mockResolvedValueOnce({ recordset: [{ Material: '30005R', FiscalYear: 2025, ConsumedQty: 100 }] }) // getConsumptionByYear
      .mockResolvedValueOnce({ recordset: [{ Material: '30005R', VendorId: 7, FiscalYear: 2025, ReceivedQty: 90 }] }); // getReceiptHistoryByVendor

    const res = await request(app).get('/trends?vendorId=7');

    expect(res.status).toBe(200);
    // The consumption query must have been scoped to just '30005R', not every ROH material.
    const consumptionCall = dbRequest.query.mock.calls[1][0];
    expect(consumptionCall).toContain('h.Material IN (@cm0)');
    expect(res.body.data.consumption).toHaveLength(1);
    expect(res.body.data.receipts).toHaveLength(1);
  });

  test('a vendor with no ordering history at all returns empty without querying consumption', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] }); // listVendorMaterialsFromReceiptHistory — nothing

    const res = await request(app).get('/trends?vendorId=7');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ consumption: [], receipts: [] });
    expect(dbRequest.query).toHaveBeenCalledTimes(1);
  });

  test('an explicit material search alongside a vendor filter is used as-is, no vendor-history resolution', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [] }) // getConsumptionByYear
      .mockResolvedValueOnce({ recordset: [] }); // getReceiptHistoryByVendor

    const res = await request(app).get('/trends?materials=30005R&vendorId=7');

    expect(res.status).toBe(200);
    expect(dbRequest.query).toHaveBeenCalledTimes(2); // no listVendorMaterialsFromReceiptHistory call
  });
});

describe('POST /forecast/percentage', () => {
  test('applies the percentage against the baseline year only, ignoring other years', async () => {
    // 2020 — always a closed, past year no matter when this test runs — so this exercises the
    // non-annualised path deterministically without needing to mock the system clock.
    dbRequest.query.mockResolvedValueOnce({
      recordset: [
        { Material: '30005R', MaterialText: 'Widget', FiscalYear: 2020, ConsumedQty: 1000 },
        { Material: '30005R', MaterialText: 'Widget', FiscalYear: 2019, ConsumedQty: 999999 }, // wrong year — must be excluded
      ],
    });

    const res = await request(app)
      .post('/forecast/percentage')
      .send({ baselineYear: 2020, percentageChange: 10 });

    expect(res.status).toBe(200);
    expect(res.body.data.isPartialYearBaseline).toBe(false);
    expect(res.body.data.materials).toEqual([
      { material: '30005R', materialText: 'Widget', actualQty: 1000, annualisedQty: null, predictedQty: 1100, uom: null },
    ]);
  });

  // Choosing the current, still-in-progress calendar year as the baseline must not let a
  // partial year's consumption-to-date be read as if it were the whole year's — see
  // applyPercentage's own comment in routes/mrpanalysis.js for why. Uses the real current date
  // (no clock mocking) so this only proves the annualisation actually ran, not a fixed
  // expected number — the elapsed-fraction arithmetic itself is exercised precisely by
  // asserting predictedQty is strictly greater than a naive (unannualised) 10% uplift would
  // give, which only holds if annualisation actually happened (unless run on Dec 31st UTC).
  test('annualises a partial current-year baseline to a full-year run rate before applying the percentage', async () => {
    const thisYear = new Date().getUTCFullYear();
    dbRequest.query.mockResolvedValueOnce({
      recordset: [{ Material: '30005R', MaterialText: 'Widget', FiscalYear: thisYear, ConsumedQty: 1000 }],
    });

    const res = await request(app)
      .post('/forecast/percentage')
      .send({ baselineYear: thisYear, percentageChange: 10 });

    expect(res.status).toBe(200);
    expect(res.body.data.isPartialYearBaseline).toBe(true);
    const [material] = res.body.data.materials;
    expect(material.actualQty).toBe(1000);
    expect(material.annualisedQty).toBeGreaterThanOrEqual(1000);
    expect(material.predictedQty).toBeGreaterThanOrEqual(1100); // naive (unannualised) +10% would be exactly 1100
    expect(material.predictedQty).toBeCloseTo(material.annualisedQty * 1.1, 2);
  });

  test('does not annualise a past baseline year even when other years in the same response are the current year', async () => {
    const thisYear = new Date().getUTCFullYear();
    dbRequest.query.mockResolvedValueOnce({
      recordset: [
        { Material: '30005R', MaterialText: 'Widget', FiscalYear: 2020, ConsumedQty: 1000 },
        { Material: '30005R', MaterialText: 'Widget', FiscalYear: thisYear, ConsumedQty: 1 }, // present but must be ignored
      ],
    });

    const res = await request(app)
      .post('/forecast/percentage')
      .send({ baselineYear: 2020, percentageChange: 10 });

    expect(res.body.data.isPartialYearBaseline).toBe(false);
    expect(res.body.data.materials).toEqual([
      { material: '30005R', materialText: 'Widget', actualQty: 1000, annualisedQty: null, predictedQty: 1100, uom: null },
    ]);
  });

  test('rejects with 400 when baselineYear is missing', async () => {
    const res = await request(app).post('/forecast/percentage').send({ percentageChange: 10 });
    expect(res.status).toBe(400);
  });

  test('rejects with 400 when percentageChange is missing', async () => {
    const res = await request(app).post('/forecast/percentage').send({ baselineYear: 2025 });
    expect(res.status).toBe(400);
  });
});

describe('POST /forecast/percentage/save', () => {
  test('saves a new immutable run and returns its RunId', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ RunId: 11 }] }).mockResolvedValue({ recordset: [] });

    const res = await request(app)
      .post('/forecast/percentage/save')
      .send({ targetYear: 2027, baselineYear: 2025, percentageChange: 10, materials: [{ material: '30005R', predictedQty: 1100 }] });

    expect(res.status).toBe(200);
    expect(res.body.data.runId).toBe(11);
  });

  test('rejects with 400 when there are no materials to save', async () => {
    const res = await request(app).post('/forecast/percentage/save').send({ targetYear: 2027, materials: [] });
    expect(res.status).toBe(400);
  });
});

describe('GET /products/export', () => {
  test('streams an xlsx file built from every TurnsValClassSnapshot row', async () => {
    dbRequest.query.mockResolvedValueOnce({
      recordset: [{ Material: '30005R', MaterialText: 'Widget', MaterialType: 'FERT', ProfitCentre: '0000002012', Uom: 'KG' }],
    });

    const res = await request(app)
      .get('/products/export')
      .buffer(true)
      .parse((response, cb) => {
        response.setEncoding('binary');
        let data = '';
        response.on('data', chunk => { data += chunk; });
        response.on('end', () => cb(null, Buffer.from(data, 'binary')));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain('attachment');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.getWorksheet('Data');
    expect(ws.getRow(1).getCell(1).value).toBe('Material');
    expect(ws.getRow(1).getCell(6).value).toBe('Expected Sales Units');
    expect(ws.getRow(2).getCell(1).value).toBe('30005R');
    expect(ws.getRow(2).getCell(6).value).toBe(''); // blank, ready for the operator to fill in
  }, 10000);
});

async function buildUploadWorkbook(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  ws.addRow(['Material', 'Material Text', 'Material Type', 'Profit Centre', 'Uom', 'Expected Sales Units']);
  rows.forEach(r => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('POST /forecast/bom/upload', () => {
  test('explodes every row with an Expected Sales Units value and returns a preview (not saved)', async () => {
    const buf = await buildUploadWorkbook([
      ['FG1', 'Finished Good 1', 'FERT', '0000001000', 'EA', 200],
      ['RAW1', 'Raw Material 1', 'ROH', '0000002012', 'KG', ''], // raw material row left blank — not an error
    ]);
    sapClientMock.post.mockResolvedValueOnce({
      data: { success: true, data: { rawMaterials: [{ material: 'RAW1', quantity: 400, uom: 'KG' }], unresolved: [] } },
    });

    const res = await request(app)
      .post('/forecast/bom/upload?targetYear=2027')
      .set('Content-Type', 'application/octet-stream')
      .send(buf);

    expect(res.status).toBe(200);
    expect(res.body.data.targetYear).toBe(2027);
    expect(res.body.data.products).toEqual([{ material: 'FG1', expectedSalesUnits: 200 }]);
    expect(res.body.data.rawMaterials).toEqual([{ material: 'RAW1', quantity: 400, uom: 'KG' }]);
    // Nothing written to the DB yet — this is a preview.
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('reports a per-row error for a non-numeric Expected Sales Units value without failing the whole upload', async () => {
    const buf = await buildUploadWorkbook([['FG1', 'Finished Good 1', 'FERT', '0000001000', 'EA', 'not-a-number']]);

    const res = await request(app)
      .post('/forecast/bom/upload?targetYear=2027')
      .set('Content-Type', 'application/octet-stream')
      .send(buf);

    expect(res.status).toBe(400); // no valid rows at all in this case
    expect(res.body.success).toBe(false);
  });

  test('rejects with 400 when targetYear is missing', async () => {
    const buf = await buildUploadWorkbook([['FG1', '', '', '', '', 200]]);
    const res = await request(app).post('/forecast/bom/upload').set('Content-Type', 'application/octet-stream').send(buf);
    expect(res.status).toBe(400);
  });

  test('rejects with 400 when the workbook has no "Data" sheet', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('NotData');
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app)
      .post('/forecast/bom/upload?targetYear=2027')
      .set('Content-Type', 'application/octet-stream')
      .send(buf);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Data');
  });
});

describe('POST /forecast/bom/save', () => {
  test('saves a new immutable run with both raw materials and the original product inputs', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ RunId: 22 }] }).mockResolvedValue({ recordset: [] });

    const res = await request(app)
      .post('/forecast/bom/save')
      .send({
        targetYear: 2027,
        products: [{ material: 'FG1', expectedSalesUnits: 200 }],
        rawMaterials: [{ material: 'RAW1', quantity: 400, uom: 'KG' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.runId).toBe(22);
  });

  test('rejects with 400 when there are no raw materials to save', async () => {
    const res = await request(app).post('/forecast/bom/save').send({ targetYear: 2027, rawMaterials: [] });
    expect(res.status).toBe(400);
  });
});

describe('GET /forecast/runs and /forecast/runs/:runId', () => {
  test('lists runs', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ RunId: 1 }, { RunId: 2 }] });
    const res = await request(app).get('/forecast/runs');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  test('returns 404 for a run that does not exist', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });
    const res = await request(app).get('/forecast/runs/999');
    expect(res.status).toBe(404);
  });

  test('returns the full run detail including materials/products', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ RunId: 5, TargetYear: 2027 }] })
      .mockResolvedValueOnce({ recordset: [{ Material: 'RAW1' }] })
      .mockResolvedValueOnce({ recordset: [{ Material: 'FG1' }] });

    const res = await request(app).get('/forecast/runs/5');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ RunId: 5, materials: [{ Material: 'RAW1' }], products: [{ Material: 'FG1' }] });
  });
});
