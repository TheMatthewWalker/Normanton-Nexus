// runMrpHistoryRefresh (routes/performancesync.js). Mocking performancesap.js/
// performancesql.js wholesale isn't viable here — both are large modules with many exports
// shared by performancesync.js's OTHER sync functions and by sibling modules
// (performanceorderlink.js etc.) that import them directly too, so a partial mock namespace
// breaks on a missing export. Instead this mocks one level deeper, the same way
// test/routes/performance.receiveGr.test.js does for the SAP side: axios (which
// performancesap.js wraps into its own client) and mssql (which performancesql.js's real
// upsert/query functions run against) — the real performancesap.js/performancesql.js modules
// load normally and exercise real logic, only their I/O is faked.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const sapClientMock = { get: jest.fn(), post: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: { create: jest.fn(() => sapClientMock) } }));

let runMrpHistoryRefresh;

beforeAll(async () => {
  ({ runMrpHistoryRefresh } = await import('../../routes/performancesync.js'));
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  sapClientMock.get.mockReset();
  sapClientMock.post.mockReset();
});

// startRefresh's own INSERT...OUTPUT — always the first query issued.
function queueStartRefresh(runId = 42) {
  dbRequest.query.mockResolvedValueOnce({ recordset: [{ RunId: runId }] });
}

// listRohMaterials' own SELECT — issued in the same Promise.all as the two SapServer calls,
// so the second query overall (right after startRefresh's). Only materials in this set survive
// into the upserts — see syncMrpHistory's own comment for why non-ROH rows are dropped.
function queueRohMaterials(materials) {
  dbRequest.query.mockResolvedValueOnce({ recordset: materials.map(Material => ({ Material })) });
}

describe('runMrpHistoryRefresh', () => {
  test('upserts consumption history stamped with Plant 3012, from the SapServer response shape', async () => {
    queueStartRefresh();
    queueRohMaterials(['30005R']);
    sapClientMock.get
      .mockResolvedValueOnce({ data: { success: true, data: [{ material: '30005R', fiscalYear: 2025, qty: 100 }] } }) // consumption-by-year
      .mockResolvedValueOnce({ data: { success: true, data: [] } }); // goods-receipt-history
    dbRequest.query.mockResolvedValue({ recordset: [] }); // Vendor lookup + upsertBatch calls + completeRefresh

    await runMrpHistoryRefresh();

    // upsertMaterialConsumptionHistory's staging INSERT carries the mapped row through as
    // bound parameters — check the material/year/qty values landed, not the raw SQL text.
    const materialInputs = dbRequest.input.mock.calls.filter(c => typeof c[0] === 'string' && c[0].startsWith('i0_'));
    expect(materialInputs.some(c => c[2] === '30005R')).toBe(true);
    expect(materialInputs.some(c => c[2] === '3012')).toBe(true);
    expect(materialInputs.some(c => c[2] === 2025)).toBe(true);
    expect(materialInputs.some(c => c[2] === 100)).toBe(true);
  });

  test('drops a material SapServer returned that is not a ROH material, before storing anything', async () => {
    queueStartRefresh();
    queueRohMaterials(['30005R']); // NOT '99999X'
    sapClientMock.get
      .mockResolvedValueOnce({ data: { success: true, data: [{ material: '30005R', fiscalYear: 2025, qty: 100 }, { material: '99999X', fiscalYear: 2025, qty: 999 }] } })
      .mockResolvedValueOnce({ data: { success: true, data: [] } });
    dbRequest.query.mockResolvedValue({ recordset: [] });

    const result = await runMrpHistoryRefresh();

    expect(result.rowCount).toBe(1); // only the ROH material counted
    const materialInputs = dbRequest.input.mock.calls.filter(c => typeof c[0] === 'string' && (c[0].startsWith('i0_') || c[0].startsWith('u0_')));
    expect(materialInputs.some(c => c[2] === '99999X')).toBe(false);
  });

  test('logs the refresh via RefreshLog with the combined consumption+receipt row count', async () => {
    queueStartRefresh(42);
    queueRohMaterials(['A', 'B']);
    sapClientMock.get
      .mockResolvedValueOnce({ data: { success: true, data: [{ material: 'A', fiscalYear: 2025, qty: 1 }, { material: 'B', fiscalYear: 2025, qty: 2 }] } })
      .mockResolvedValueOnce({ data: { success: true, data: [{ material: 'A', vendor: '1', year: 2025, qty: 1, uom: 'KG' }] } });
    dbRequest.query.mockResolvedValue({ recordset: [] });

    const result = await runMrpHistoryRefresh();

    expect(result).toMatchObject({ name: 'MrpAnalysisHistory', status: 'success', rowCount: 3 });
    const completeCall = dbRequest.query.mock.calls.find(c => /UPDATE dbo\.RefreshLog/.test(c[0]));
    expect(completeCall).toBeDefined();
    const totalRowsInput = dbRequest.input.mock.calls.find(c => c[0] === 'totalRows');
    expect(totalRowsInput[2]).toBe(3);
  });

  test('bounds the goods-receipt-history SAP call to a sinceDate ~5 years back, matching the consumption window', async () => {
    queueStartRefresh();
    queueRohMaterials([]);
    sapClientMock.get.mockResolvedValue({ data: { success: true, data: [] } });
    dbRequest.query.mockResolvedValue({ recordset: [] });

    await runMrpHistoryRefresh();

    const grCall = sapClientMock.get.mock.calls.find(c => c[0] === '/api/mrp-analysis/goods-receipt-history');
    expect(grCall[1].params.sinceDate).toBe(`01.01.${new Date().getFullYear() - 4}`);
  });

  test('reports status failed (via failRefresh) rather than throwing when the SAP call rejects', async () => {
    queueStartRefresh();
    sapClientMock.get.mockRejectedValue(new Error('SapServer unreachable'));

    const result = await runMrpHistoryRefresh();

    expect(result).toMatchObject({ name: 'MrpAnalysisHistory', status: 'failed', error: 'SapServer unreachable' });
    const failCall = dbRequest.query.mock.calls.find(c => /UPDATE dbo\.RefreshLog/.test(c[0]) && /Failed/.test(c[0]));
    expect(failCall).toBeDefined();
  });

  test('a second call while one is already in flight reuses the same promise instead of starting a second run', async () => {
    let resolveGet;
    queueStartRefresh();
    sapClientMock.get.mockReturnValue(new Promise(res => { resolveGet = res; }));
    dbRequest.query.mockResolvedValue({ recordset: [] });

    const first = runMrpHistoryRefresh();
    const second = runMrpHistoryRefresh();
    expect(first).toBe(second);

    resolveGet({ data: { success: true, data: [] } });
    await Promise.all([first, second]);

    // startRefresh's own INSERT ran exactly once across both calls.
    const startCalls = dbRequest.query.mock.calls.filter(c => /INSERT INTO dbo\.RefreshLog/.test(c[0]));
    expect(startCalls).toHaveLength(1);
  });
});
