// Targets performancesql.js's MRP Analysis additions directly (mssql mocked) — the two
// history upsert functions (log.MaterialConsumptionHistory/log.MaterialReceiptHistory, both
// built on the existing upsertBatch helper — see that function's own comment in
// performancesql.js for why LastUpdatedUtc is hardcoded into its UPDATE branch, which is why
// these two tables use that exact column name rather than a bespoke one), the two trend
// read queries, and the immutable forecast-snapshot CRUD
// (log.MrpForecastRun/MrpForecastRunMaterial/MrpForecastRunProduct).

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let upsertMaterialConsumptionHistory;
let upsertMaterialReceiptHistory;
let getConsumptionByYear;
let getReceiptHistoryByVendor;
let createMrpForecastRun;
let listMrpForecastRuns;
let getMrpForecastRunDetail;

beforeAll(async () => {
  ({
    upsertMaterialConsumptionHistory, upsertMaterialReceiptHistory,
    getConsumptionByYear, getReceiptHistoryByVendor,
    createMrpForecastRun, listMrpForecastRuns, getMrpForecastRunDetail,
  } = await import('../../routes/performancesql.js'));
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function inputCalls(name) {
  return dbRequest.input.mock.calls.filter(call => call[0] === name).map(call => call[2]);
}

describe('upsertMaterialConsumptionHistory', () => {
  test('stages the mapped row through as bound parameters', async () => {
    dbRequest.query.mockResolvedValue({ recordset: [] });

    await upsertMaterialConsumptionHistory([{ material: '30005R', plant: '3012', fiscalYear: 2025, consumedQty: 100 }]);

    const stagedValues = dbRequest.input.mock.calls
      .filter(c => typeof c[0] === 'string' && (c[0].startsWith('i0_') || c[0].startsWith('u0_')))
      .map(c => c[2]);
    expect(stagedValues).toEqual(expect.arrayContaining(['30005R', '3012', 2025, 100]));
  });

  test('does nothing (no query at all) for an empty row list', async () => {
    await upsertMaterialConsumptionHistory([]);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });
});

describe('upsertMaterialReceiptHistory', () => {
  test('resolves VendorId from log.Vendor.SapVendorNumber for a matching row', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ VendorId: 7, SapVendorNumber: '0000012345' }] }) // Vendor lookup
      .mockResolvedValue({ recordset: [] });

    await upsertMaterialReceiptHistory([
      { material: '30005R', plant: '3012', sapVendorNumber: '0000012345', fiscalYear: 2025, receivedQty: 100, uom: 'KG' },
    ]);

    const stagedValues = dbRequest.input.mock.calls
      .filter(c => typeof c[0] === 'string' && (c[0].startsWith('i0_') || c[0].startsWith('u0_')))
      .map(c => c[2]);
    expect(stagedValues).toContain(7);
  });

  test('leaves VendorId null for a vendor not yet in log.Vendor rather than dropping the row', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [] }) // no vendors at all
      .mockResolvedValue({ recordset: [] });

    await upsertMaterialReceiptHistory([
      { material: '30005R', plant: '3012', sapVendorNumber: '0000099999', fiscalYear: 2025, receivedQty: 100, uom: 'KG' },
    ]);

    // The row itself still gets staged (keyed by SapVendorNumber), not skipped — VendorId
    // is simply one of the (otherwise all non-null) staged values, so its absence would
    // show up as a missing null in an all-non-null row.
    const stagedValues = dbRequest.input.mock.calls
      .filter(c => typeof c[0] === 'string' && (c[0].startsWith('i0_') || c[0].startsWith('u0_')))
      .map(c => c[2]);
    expect(stagedValues).toContain('0000099999');
    expect(stagedValues.filter(v => v === null)).toHaveLength(2); // VendorId, once for INSERT staging + once for UPDATE staging
  });

  test('does nothing (no query at all) for an empty row list', async () => {
    await upsertMaterialReceiptHistory([]);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });
});

describe('getConsumptionByYear', () => {
  test('queries with no material filter when none is given', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ Material: '30005R', FiscalYear: 2025, ConsumedQty: 100 }] });

    const rows = await getConsumptionByYear();

    expect(dbRequest.query.mock.calls[0][0]).not.toContain('WHERE');
    expect(rows).toEqual([{ Material: '30005R', FiscalYear: 2025, ConsumedQty: 100 }]);
  });

  test('filters by an IN-list of materials when given', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });

    await getConsumptionByYear(['30005R', '30006R']);

    expect(dbRequest.query.mock.calls[0][0]).toContain('h.Material IN (@cm0,@cm1)');
    expect(inputCalls('cm0')).toEqual(['30005R']);
    expect(inputCalls('cm1')).toEqual(['30006R']);
  });
});

describe('getReceiptHistoryByVendor', () => {
  test('queries with no filters when none are given', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });

    await getReceiptHistoryByVendor();

    expect(dbRequest.query.mock.calls[0][0]).not.toContain('WHERE');
  });

  test('combines a material filter and a vendor filter with AND', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });

    await getReceiptHistoryByVendor(['30005R'], 7);

    const queryText = dbRequest.query.mock.calls[0][0];
    expect(queryText).toContain('h.Material IN (@rm0)');
    expect(queryText).toContain('h.VendorId = @vendorId');
    expect(queryText).toContain(' AND ');
    expect(inputCalls('vendorId')).toEqual([7]);
  });
});

describe('createMrpForecastRun', () => {
  test('inserts the run header, returns the new RunId, and stages every material row', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ RunId: 5 }] }) // INSERT ... OUTPUT
      .mockResolvedValue({ recordset: [] }); // material/product upsertBatch calls

    const runId = await createMrpForecastRun({
      targetYear: 2027, method: 'Percentage', baselineYear: 2026, percentageChange: 10,
      createdBy: 'tester',
      materials: [{ material: '30005R', predictedQty: 1000, uom: 'KG' }],
    });

    expect(runId).toBe(5);
    expect(inputCalls('targetYear')).toEqual([2027]);
    expect(inputCalls('method')).toEqual(['Percentage']);

    const stagedValues = dbRequest.input.mock.calls
      .filter(c => typeof c[0] === 'string' && (c[0].startsWith('i0_') || c[0].startsWith('u0_')))
      .map(c => c[2]);
    expect(stagedValues).toEqual(expect.arrayContaining([5, '30005R', 1000]));
  });

  test('also stages product rows when given (BomBreakdown method)', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ RunId: 9 }] })
      .mockResolvedValue({ recordset: [] });

    await createMrpForecastRun({
      targetYear: 2027, method: 'BomBreakdown', createdBy: 'tester',
      materials: [{ material: 'RAW1', predictedQty: 500, uom: 'KG' }],
      products: [{ material: 'FG1', expectedSalesUnits: 200 }],
    });

    const stagedValues = dbRequest.input.mock.calls
      .filter(c => typeof c[0] === 'string' && (c[0].startsWith('i0_') || c[0].startsWith('u0_')))
      .map(c => c[2]);
    expect(stagedValues).toEqual(expect.arrayContaining(['FG1', 200]));
  });

  test('skips the product upsert entirely when none are given (Percentage method)', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ RunId: 3 }] })
      .mockResolvedValue({ recordset: [] });

    await createMrpForecastRun({
      targetYear: 2027, method: 'Percentage', createdBy: 'tester',
      materials: [{ material: '30005R', predictedQty: 1000, uom: 'KG' }],
    });

    expect(dbRequest.query.mock.calls.some(c => /MrpForecastRunProduct/.test(c[0]))).toBe(false);
  });
});

describe('listMrpForecastRuns', () => {
  test('lists every run when no targetYear filter is given', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ RunId: 1 }, { RunId: 2 }] });
    const rows = await listMrpForecastRuns();
    expect(dbRequest.query.mock.calls[0][0]).not.toContain('WHERE');
    expect(rows).toHaveLength(2);
  });

  test('filters to one targetYear when given', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });
    await listMrpForecastRuns(2027);
    expect(dbRequest.query.mock.calls[0][0]).toContain('WHERE TargetYear = @targetYear');
    expect(inputCalls('targetYear')).toEqual([2027]);
  });
});

describe('getMrpForecastRunDetail', () => {
  test('returns null when the run does not exist, without querying the child tables', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] }); // run lookup — not found

    const result = await getMrpForecastRunDetail(999);

    expect(result).toBeNull();
    expect(dbRequest.query).toHaveBeenCalledTimes(1);
  });

  test('combines the run header with its material and product rows', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ RunId: 5, TargetYear: 2027, Method: 'BomBreakdown' }] })
      .mockResolvedValueOnce({ recordset: [{ Material: 'RAW1', PredictedQty: 500 }] })
      .mockResolvedValueOnce({ recordset: [{ Material: 'FG1', ExpectedSalesUnits: 200 }] });

    const result = await getMrpForecastRunDetail(5);

    expect(result).toMatchObject({
      RunId: 5, TargetYear: 2027, Method: 'BomBreakdown',
      materials: [{ Material: 'RAW1', PredictedQty: 500 }],
      products: [{ Material: 'FG1', ExpectedSalesUnits: 200 }],
    });
  });
});
