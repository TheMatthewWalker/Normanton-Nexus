// routes/stockcount.js delegates persistence to stockcountsql.js (`db`,
// mocked wholesale) and all SAP calls (LQUA comparison lookups, bin-storage-
// types for the location map, stock-adjustment postings) to axios directly.
// Covers material lookup/validation, the LOG_SUPER-gated location map, count
// reads/creation, line entry (all three CountType branches of
// resolveSapComparisonForLine), Invalid Materials correction, bin
// completion, and the submit -> finance-approve/reject -> 711/712-post
// pipeline. Finished Goods Count's scan flow is a separate pipeline, covered
// once that stage lands.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const db = {
  searchMaterialForCount: jest.fn(),
  searchMaterialsForCount: jest.fn(),
  fuzzyMatchMaterial: jest.fn(),
  listLocationMap: jest.fn(),
  upsertLocationMap: jest.fn(),
  getLocationMapEntry: jest.fn(),
  listCountDocuments: jest.fn(),
  getCountDocument: jest.fn(),
  createCountDocument: jest.fn(),
  listCountLines: jest.fn(),
  listInvalidLines: jest.fn(),
  countHasInvalidLines: jest.fn(),
  countHasIncompleteBins: jest.fn(),
  addCountLine: jest.fn(),
  correctInvalidMaterialLine: jest.fn(),
  markBinComplete: jest.fn(),
  updateCountStatus: jest.fn(),
  getCountReportByMaterial: jest.fn(),
  getCountReportByMaterialAndBin: jest.fn(),
  getOrCreatePtfeCountForWeek: jest.fn(),
  getActiveFgSession: jest.fn(),
  recordFgScan: jest.fn(),
  listConfirmedBatchesInBin: jest.fn(),
  findOpenDiscrepancy: jest.fn(),
  createDiscrepancy: jest.fn(),
  resolveDiscrepancy: jest.fn(),
  getDiscrepancy: jest.fn(),
  listOpenDiscrepancies: jest.fn(),
};
jest.unstable_mockModule('../../routes/stockcountsql.js', () => db);

const axiosMock = { get: jest.fn(), post: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

const notifyMock = jest.fn();
jest.unstable_mockModule('../../lib/notify.js', () => ({ notify: notifyMock }));

const logSuperUser = { ...operatorUser, permissions: ['LOG_SUPER'] };
const financeUser = { ...operatorUser, userID: 501, username: 'f.controller', permissions: ['FIN_STOCK_APPROVE'] };

let stockCountRouter;
let app;
let appLogSuper;
let appFinance;

beforeAll(async () => {
  ({ default: stockCountRouter } = await import('../../routes/stockcount.js'));
  app = buildTestApp(stockCountRouter, { sessionUser: operatorUser });
  appLogSuper = buildTestApp(stockCountRouter, { sessionUser: logSuperUser });
  appFinance = buildTestApp(stockCountRouter, { sessionUser: financeUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  Object.values(db).forEach(fn => fn.mockReset());
  axiosMock.get.mockReset();
  axiosMock.post.mockReset();
  notifyMock.mockReset();
  notifyMock.mockResolvedValue(undefined);
  dbRequest.query.mockResolvedValue({ recordset: [] }); // audit() defaults to succeeding
});

describe('GET /materials', () => {
  test('400s without a search term', async () => {
    const res = await request(app).get('/materials');
    expect(res.status).toBe(400);
    expect(db.searchMaterialsForCount).not.toHaveBeenCalled();
  });

  test('searches when given a term', async () => {
    db.searchMaterialsForCount.mockResolvedValueOnce([{ material: '30005R' }]);
    const res = await request(app).get('/materials?search=3000');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ material: '30005R' }]);
  });
});

describe('GET /materials/:material/validate', () => {
  test('returns valid:true with the resolved fields on a match', async () => {
    db.searchMaterialForCount.mockResolvedValueOnce({ material: '30005R', materialText: 'Wire', uom: 'M' });
    const res = await request(app).get('/materials/30005R/validate');
    expect(res.body.data).toEqual({ valid: true, material: '30005R', materialText: 'Wire', uom: 'M' });
    expect(db.fuzzyMatchMaterial).not.toHaveBeenCalled();
  });

  test('returns valid:false with fuzzy suggestions when there is no match', async () => {
    db.searchMaterialForCount.mockResolvedValueOnce(null);
    db.fuzzyMatchMaterial.mockResolvedValueOnce([{ material: '30005R', distance: 1 }]);
    const res = await request(app).get('/materials/30005X/validate');
    expect(res.body.data).toEqual({ valid: false, suggestions: [{ material: '30005R', distance: 1 }] });
  });
});

describe('GET /location-map', () => {
  test('lists the active mapping', async () => {
    db.listLocationMap.mockResolvedValueOnce([{ NamedLocation: 'PTFE', StorageType: 'PTF', Bin: 'B01' }]);
    const res = await request(app).get('/location-map');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

describe('PUT /location-map/:namedLocation', () => {
  test('is rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).put('/location-map/PTFE').send({ storageType: 'PTF', bin: 'B01' });
    expect(res.status).toBe(403);
    expect(axiosMock.get).not.toHaveBeenCalled();
  });

  test('400s when storageType or bin is missing', async () => {
    const res = await request(appLogSuper).put('/location-map/PTFE').send({ storageType: 'PTF' });
    expect(res.status).toBe(400);
    expect(axiosMock.get).not.toHaveBeenCalled();
  });

  test('422s when the bin is not registered in SAP LAGP under that storage type', async () => {
    axiosMock.get.mockResolvedValueOnce({ data: { success: true, data: ['SA', 'PDR'] } }); // no 'PTF'
    const res = await request(appLogSuper).put('/location-map/PTFE').send({ storageType: 'PTF', bin: 'B01' });
    expect(res.status).toBe(422);
    expect(db.upsertLocationMap).not.toHaveBeenCalled();
  });

  test('saves the mapping when SAP confirms the bin/storage-type combination', async () => {
    axiosMock.get.mockResolvedValueOnce({ data: { success: true, data: ['PTF', 'SA'] } });
    db.upsertLocationMap.mockResolvedValueOnce(11);
    const res = await request(appLogSuper).put('/location-map/PTFE').send({ storageType: 'PTF', bin: 'B01' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ mapId: 11 });
    expect(db.upsertLocationMap).toHaveBeenCalledWith('PTFE', { storageType: 'PTF', bin: 'B01', updatedBy: logSuperUser.username });
  });
});

describe('GET /counts/current-ptfe', () => {
  test('lazily creates the week\'s count and returns it with lines', async () => {
    db.getOrCreatePtfeCountForWeek.mockResolvedValueOnce({ countId: 4, created: true });
    db.getCountDocument.mockResolvedValueOnce({ CountId: 4, CountType: 'PTFE_WEEKLY', Status: 'Open' });
    db.listCountLines.mockResolvedValueOnce([]);

    const res = await request(app).get('/counts/current-ptfe');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ CountId: 4, CountType: 'PTFE_WEEKLY', lines: [] });
  });
});

describe('GET /counts/:id', () => {
  test('404s when the count does not exist', async () => {
    db.getCountDocument.mockResolvedValueOnce(null);
    const res = await request(app).get('/counts/999');
    expect(res.status).toBe(404);
  });

  test('returns the document with its lines', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 1, CountType: 'RAW_MATERIAL' });
    db.listCountLines.mockResolvedValueOnce([{ LineId: 1, Material: '30005R' }]);
    const res = await request(app).get('/counts/1');
    expect(res.body.data.lines).toHaveLength(1);
  });
});

describe('POST /counts', () => {
  test('is rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).post('/counts').send({ countType: 'RAW_MATERIAL', storageLocation: '1710' });
    expect(res.status).toBe(403);
    expect(db.createCountDocument).not.toHaveBeenCalled();
  });

  test('400s on an unrecognised countType', async () => {
    const res = await request(appLogSuper).post('/counts').send({ countType: 'PTFE_WEEKLY', storageLocation: '1710' });
    expect(res.status).toBe(400);
  });

  test('400s without a storageLocation', async () => {
    const res = await request(appLogSuper).post('/counts').send({ countType: 'RAW_MATERIAL' });
    expect(res.status).toBe(400);
  });

  test('starts a Raw Material count', async () => {
    db.createCountDocument.mockResolvedValueOnce(42);
    const res = await request(appLogSuper).post('/counts').send({ countType: 'RAW_MATERIAL', storageLocation: '1710', ticketNumber: 'T-1' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ countId: 42 });
    expect(db.createCountDocument).toHaveBeenCalledWith(expect.objectContaining({
      countType: 'RAW_MATERIAL', storageLocation: '1710', ticketNumber: 'T-1', createdBy: logSuperUser.username,
    }));
  });
});

describe('POST /counts/:id/lines', () => {
  test('400s without material or countedQty', async () => {
    const res = await request(app).post('/counts/1/lines').send({ material: '30005R' });
    expect(res.status).toBe(400);
  });

  test('404s when the count does not exist', async () => {
    db.getCountDocument.mockResolvedValueOnce(null);
    const res = await request(app).post('/counts/999/lines').send({ material: '30005R', countedQty: 10 });
    expect(res.status).toBe(404);
  });

  test('400s when the count is not Open', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 1, CountType: 'RAW_MATERIAL', Status: 'PendingApproval' });
    const res = await request(app).post('/counts/1/lines').send({ material: '30005R', countedQty: 10 });
    expect(res.status).toBe(400);
  });

  test('saves an invalid-material line without querying SAP, and does not compute a variance', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 1, CountType: 'RAW_MATERIAL', Status: 'Open', StorageLocation: '1710' });
    db.searchMaterialForCount.mockResolvedValueOnce(null);
    db.addCountLine.mockResolvedValueOnce(7);

    const res = await request(app).post('/counts/1/lines').send({
      material: 'BOGUS', storageType: 'PDR', bin: 'B01', countedQty: 10,
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ lineId: 7, isInvalidMaterial: true });
    expect(axiosMock.get).not.toHaveBeenCalled();
    expect(db.addCountLine).toHaveBeenCalledWith('1', expect.objectContaining({ sapQty: null, isInvalidMaterial: true }));
  });

  test('RAW_MATERIAL: compares against LQUA filtered by storage type/bin/storage location', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 1, CountType: 'RAW_MATERIAL', Status: 'Open', StorageLocation: '1710' });
    db.searchMaterialForCount.mockResolvedValueOnce({ material: '30005R', materialText: 'Wire', uom: 'M', unitPrice: 2 });
    axiosMock.get.mockResolvedValueOnce({ data: { success: true, data: [{ availableQty: 90 }, { availableQty: 5 }] } });
    db.addCountLine.mockResolvedValueOnce(8);

    const res = await request(app).post('/counts/1/lines').send({
      material: '30005R', storageType: 'PDR', bin: 'B01', countedQty: 100,
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ lineId: 8, isInvalidMaterial: false, sapQty: 95 });
    expect(axiosMock.get.mock.calls[0][1].params).toMatchObject({ material: '30005R', storageType: 'PDR', bin: 'B01', storageLocation: '1710' });
    expect(db.addCountLine).toHaveBeenCalledWith('1', expect.objectContaining({ sapQty: 95, storageType: 'PDR', bin: 'B01' }));
  });

  test('PTFE_WEEKLY: resolves the named location through the location map, excludes bin type SA', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 2, CountType: 'PTFE_WEEKLY', Status: 'Open', StorageLocation: null });
    db.searchMaterialForCount.mockResolvedValueOnce({ material: '10000', materialText: 'Teflon', uom: 'KG', unitPrice: 1 });
    db.getLocationMapEntry.mockResolvedValueOnce({ StorageType: 'PTF', Bin: 'B02' });
    axiosMock.get.mockResolvedValueOnce({ data: { success: true, data: [{ availableQty: 350 }] } });
    db.addCountLine.mockResolvedValueOnce(9);

    const res = await request(app).post('/counts/2/lines').send({ material: '10000', namedLocation: 'PTFE', countedQty: 340 });

    expect(res.status).toBe(200);
    expect(res.body.data.sapQty).toBe(350);
    expect(db.getLocationMapEntry).toHaveBeenCalledWith('PTFE');
    expect(axiosMock.get.mock.calls[0][1].params).toMatchObject({ material: '10000', storageType: 'PTF', bin: 'B02', excludeStorageType: 'SA' });
  });

  test('PTFE_WEEKLY: 500s with a clear message when the named location has no mapping', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 2, CountType: 'PTFE_WEEKLY', Status: 'Open' });
    db.searchMaterialForCount.mockResolvedValueOnce({ material: '10000' });
    db.getLocationMapEntry.mockResolvedValueOnce(null);

    const res = await request(app).post('/counts/2/lines').send({ material: '10000', namedLocation: 'YARD', countedQty: 10 });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/No SAP bin mapping configured for location "YARD"/);
  });

  // PRODUCTION sums MARD@1716 (SapServer's im-stock endpoint — 1716 has no
  // WM/bin concept and never appears in LQUA) with LQUA@1710/SA/PTFE
  // (material already issued to production physically sits there), and
  // separately probes LQUA for the material anywhere at all to detect
  // batch-managed materials that should redirect to Finished Goods Count.
  test('PRODUCTION: sums MARD@1716 and LQUA@1710/SA/PTFE for the comparison qty', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 3, CountType: 'PRODUCTION', Status: 'Open', StorageLocation: '1716' });
    db.searchMaterialForCount.mockResolvedValueOnce({ material: '40002', uom: 'EA' });
    axiosMock.get
      .mockResolvedValueOnce({ data: { success: true, data: [{ availableQty: 20 }] } })   // im-stock @ 1716
      .mockResolvedValueOnce({ data: { success: true, data: [{ availableQty: 5 }] } })    // LQUA @ 1710/SA/PTFE
      .mockResolvedValueOnce({ data: { success: true, data: [] } });                       // broad LQUA (batch check)
    db.addCountLine.mockResolvedValueOnce(11);

    const res = await request(app).post('/counts/3/lines').send({ material: '40002', countedQty: 20 });

    expect(res.status).toBe(200);
    expect(res.body.data.sapQty).toBe(25);
    expect(axiosMock.get.mock.calls[0][0]).toContain('/api/warehouse/im-stock');
    expect(axiosMock.get.mock.calls[0][1].params).toMatchObject({ material: '40002', storageLocation: '1716' });
    expect(axiosMock.get.mock.calls[1][0]).toContain('/api/warehouse/stock');
    expect(axiosMock.get.mock.calls[1][1].params).toMatchObject({ material: '40002', storageType: 'SA', bin: 'PTFE', storageLocation: '1710' });
    expect(db.addCountLine).toHaveBeenCalledWith('3', expect.objectContaining({ sapQty: 25, storageType: null, bin: null }));
  });

  test('PRODUCTION: flags a batch-managed material (found anywhere in LQUA) and signals redirectToFinishedGoodsCount', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 3, CountType: 'PRODUCTION', Status: 'Open', StorageLocation: '1716' });
    db.searchMaterialForCount.mockResolvedValueOnce({ material: '40001', materialText: 'FG Item', uom: 'EA' });
    axiosMock.get
      .mockResolvedValueOnce({ data: { success: true, data: [] } })                                       // im-stock @ 1716 — nothing
      .mockResolvedValueOnce({ data: { success: true, data: [] } })                                       // LQUA @ 1710/SA/PTFE — nothing
      .mockResolvedValueOnce({ data: { success: true, data: [{ availableQty: 50, batch: 'B123' }] } });   // broad LQUA — found with a batch
    db.addCountLine.mockResolvedValueOnce(10);

    const res = await request(app).post('/counts/3/lines').send({ material: '40001', countedQty: 50 });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ isBatchManaged: true, redirectToFinishedGoodsCount: true });
    expect(db.addCountLine).toHaveBeenCalledWith('3', expect.objectContaining({ isBatchManaged: true }));
  });
});

describe('POST /counts/:id/lines — Raw Material SA exclusion', () => {
  test('400s when entering storage type SA for a Raw Material Count (already issued to production)', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 1, CountType: 'RAW_MATERIAL', Status: 'Open', StorageLocation: '1710' });
    const res = await request(app).post('/counts/1/lines').send({ material: '30005R', storageType: 'sa', bin: 'PTFE', countedQty: 10 });
    expect(res.status).toBe(400);
    expect(axiosMock.get).not.toHaveBeenCalled();
    expect(db.addCountLine).not.toHaveBeenCalled();
  });
});

describe('GET /counts/:id/invalid-lines', () => {
  test('attaches fuzzy-match suggestions to each invalid line', async () => {
    db.listInvalidLines.mockResolvedValueOnce([{ LineId: 1, Material: 'BOGUS' }]);
    db.fuzzyMatchMaterial.mockResolvedValueOnce([{ material: '30005R', distance: 2 }]);

    const res = await request(app).get('/counts/1/invalid-lines');

    expect(res.body.data).toEqual([{ LineId: 1, Material: 'BOGUS', suggestions: [{ material: '30005R', distance: 2 }] }]);
  });
});

describe('PUT /counts/:id/invalid-lines/:lineId', () => {
  test('400s without a material', async () => {
    const res = await request(app).put('/counts/1/invalid-lines/5').send({});
    expect(res.status).toBe(400);
  });

  test('422s when the replacement material still does not validate', async () => {
    db.searchMaterialForCount.mockResolvedValueOnce(null);
    const res = await request(app).put('/counts/1/invalid-lines/5').send({ material: 'STILLBOGUS' });
    expect(res.status).toBe(422);
    expect(db.correctInvalidMaterialLine).not.toHaveBeenCalled();
  });

  test('404s when the line does not exist', async () => {
    db.searchMaterialForCount.mockResolvedValueOnce({ material: '30005R', materialText: 'Wire', uom: 'M', unitPrice: 1 });
    db.correctInvalidMaterialLine.mockResolvedValueOnce(false);
    const res = await request(app).put('/counts/1/invalid-lines/999').send({ material: '30005R' });
    expect(res.status).toBe(404);
  });

  test('corrects the line and clears the invalid flag', async () => {
    db.searchMaterialForCount.mockResolvedValueOnce({ material: '30005R', materialText: 'Wire', uom: 'M', unitPrice: 1 });
    db.correctInvalidMaterialLine.mockResolvedValueOnce(true);
    const res = await request(app).put('/counts/1/invalid-lines/5').send({ material: '30005R' });
    expect(res.status).toBe(200);
    expect(db.correctInvalidMaterialLine).toHaveBeenCalledWith('5', expect.objectContaining({ material: '30005R', isInvalidMaterial: false }));
  });
});

describe('POST /counts/:id/bins/:storageType/:bin/complete', () => {
  test('is rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).post('/counts/1/bins/PDR/B01/complete');
    expect(res.status).toBe(403);
  });

  test('404s when no matching open bin line exists', async () => {
    db.markBinComplete.mockResolvedValueOnce(false);
    const res = await request(appLogSuper).post('/counts/1/bins/PDR/B01/complete');
    expect(res.status).toBe(404);
  });

  test('marks the bin complete', async () => {
    db.markBinComplete.mockResolvedValueOnce(true);
    const res = await request(appLogSuper).post('/counts/1/bins/PDR/B01/complete');
    expect(res.status).toBe(200);
  });
});

describe('POST /counts/:id/submit', () => {
  test('404s when the count does not exist', async () => {
    db.getCountDocument.mockResolvedValueOnce(null);
    const res = await request(app).post('/counts/1/submit');
    expect(res.status).toBe(404);
  });

  test('400s when the count is not Open', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 1, CountType: 'RAW_MATERIAL', Status: 'PendingApproval' });
    const res = await request(app).post('/counts/1/submit');
    expect(res.status).toBe(400);
  });

  test('422s while invalid material lines remain', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 1, CountType: 'RAW_MATERIAL', Status: 'Open' });
    db.countHasInvalidLines.mockResolvedValueOnce(true);
    const res = await request(app).post('/counts/1/submit');
    expect(res.status).toBe(422);
    expect(db.updateCountStatus).not.toHaveBeenCalled();
  });

  test('422s a Raw Material count while any bin is incomplete', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 1, CountType: 'RAW_MATERIAL', Status: 'Open' });
    db.countHasInvalidLines.mockResolvedValueOnce(false);
    db.countHasIncompleteBins.mockResolvedValueOnce(true);
    const res = await request(app).post('/counts/1/submit');
    expect(res.status).toBe(422);
  });

  test('does not check bin completeness for PTFE_WEEKLY/PRODUCTION', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 2, CountType: 'PTFE_WEEKLY', Status: 'Open' });
    db.countHasInvalidLines.mockResolvedValueOnce(false);
    db.updateCountStatus.mockResolvedValueOnce(true);

    const res = await request(app).post('/counts/2/submit');

    expect(res.status).toBe(200);
    expect(db.countHasIncompleteBins).not.toHaveBeenCalled();
  });

  test('submits, notifies FIN_STOCK_APPROVE, and audits', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 1, CountType: 'RAW_MATERIAL', Status: 'Open' });
    db.countHasInvalidLines.mockResolvedValueOnce(false);
    db.countHasIncompleteBins.mockResolvedValueOnce(false);
    db.updateCountStatus.mockResolvedValueOnce(true);

    const res = await request(app).post('/counts/1/submit');

    expect(res.status).toBe(200);
    expect(db.updateCountStatus).toHaveBeenCalledWith('1', 'PendingApproval', expect.objectContaining({ submittedBy: 'j.smith' }));
    expect(notifyMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      target: { type: 'permission', value: 'FIN_STOCK_APPROVE' },
    }));
  });
});

describe('POST /counts/:id/approve', () => {
  test('is rejected for a user without FIN_STOCK_APPROVE', async () => {
    const res = await request(app).post('/counts/1/approve');
    expect(res.status).toBe(403);
  });

  test('400s when the count is not PendingApproval', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 1, Status: 'Open' });
    const res = await request(appFinance).post('/counts/1/approve');
    expect(res.status).toBe(400);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('posts 711 for a gain and 712 for a loss, skips zero-variance lines, and marks Posted on full success', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 1, CountType: 'RAW_MATERIAL', Status: 'PendingApproval', StorageLocation: '1710' });
    db.listCountLines.mockResolvedValueOnce([
      { LineId: 1, Material: 'A', VarianceQty: 5, StorageType: 'PDR', Bin: 'B01', Uom: 'KG' },   // gain -> 711
      { LineId: 2, Material: 'B', VarianceQty: -3, StorageType: 'PDR', Bin: 'B02', Uom: 'KG' },  // loss -> 712
      { LineId: 3, Material: 'C', VarianceQty: 0, StorageType: 'PDR', Bin: 'B03', Uom: 'KG' },   // no variance -> skipped
    ]);
    axiosMock.post.mockResolvedValue({ data: { success: true, data: { materialDocument: 'MD1' } } });

    const res = await request(appFinance).post('/counts/1/approve');

    expect(res.status).toBe(200);
    expect(axiosMock.post).toHaveBeenCalledTimes(2);
    expect(res.body.data.allSucceeded).toBe(true);
    expect(res.body.data.postedLineCount).toBe(2);
    const bodies = axiosMock.post.mock.calls.map(c => c[1]);
    expect(bodies).toEqual(expect.arrayContaining([
      expect.objectContaining({ Material: 'A', MovementType: '711', Quantity: 5, StorageType: 'PDR', StorageBin: 'B01' }),
      expect.objectContaining({ Material: 'B', MovementType: '712', Quantity: 3, StorageType: 'PDR', StorageBin: 'B02' }),
    ]));
    expect(db.updateCountStatus).toHaveBeenCalledWith('1', 'Approved', expect.objectContaining({ approvedBy: financeUser.username }));
    expect(db.updateCountStatus).toHaveBeenCalledWith('1', 'Posted', expect.objectContaining({ postedByUserId: financeUser.userID }));
  });

  test('falls back to SA/PTFE bin for a Production Count line (no WM bin at 1716)', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 3, CountType: 'PRODUCTION', Status: 'PendingApproval', StorageLocation: '1716' });
    db.listCountLines.mockResolvedValueOnce([{ LineId: 1, Material: 'A', VarianceQty: 2, StorageType: null, Bin: null, Uom: 'EA' }]);
    axiosMock.post.mockResolvedValueOnce({ data: { success: true, data: {} } });

    await request(appFinance).post('/counts/3/approve');

    expect(axiosMock.post.mock.calls[0][1]).toMatchObject({ StorageType: 'SA', StorageBin: 'PTFE' });
  });

  test('leaves the count Approved (not Posted) when a posting fails, and reports the per-line error', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 1, CountType: 'RAW_MATERIAL', Status: 'PendingApproval', StorageLocation: '1710' });
    db.listCountLines.mockResolvedValueOnce([{ LineId: 1, Material: 'A', VarianceQty: 5, StorageType: 'PDR', Bin: 'B01', Uom: 'KG' }]);
    axiosMock.post.mockRejectedValueOnce(new Error('RFC timeout'));

    const res = await request(appFinance).post('/counts/1/approve');

    expect(res.status).toBe(200);
    expect(res.body.data.allSucceeded).toBe(false);
    expect(res.body.data.results[0]).toMatchObject({ lineId: 1, success: false, error: 'RFC timeout' });
    expect(db.updateCountStatus).toHaveBeenCalledWith('1', 'Approved', expect.anything());
    expect(db.updateCountStatus).not.toHaveBeenCalledWith('1', 'Posted', expect.anything());
  });
});

describe('POST /counts/:id/reject', () => {
  test('is rejected for a user without FIN_STOCK_APPROVE', async () => {
    const res = await request(app).post('/counts/1/reject').send({ reason: 'Wrong count' });
    expect(res.status).toBe(403);
  });

  test('400s without a reason', async () => {
    const res = await request(appFinance).post('/counts/1/reject').send({});
    expect(res.status).toBe(400);
    expect(db.updateCountStatus).not.toHaveBeenCalled();
  });

  test('rejects, notifies LOG_SUPER with the reason, and audits', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 1, CountType: 'RAW_MATERIAL', Status: 'PendingApproval' });
    db.updateCountStatus.mockResolvedValueOnce(true);

    const res = await request(appFinance).post('/counts/1/reject').send({ reason: 'Numbers look wrong' });

    expect(res.status).toBe(200);
    expect(db.updateCountStatus).toHaveBeenCalledWith('1', 'Rejected', expect.objectContaining({ rejectedBy: financeUser.username, rejectionReason: 'Numbers look wrong' }));
    expect(notifyMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      body: 'Numbers look wrong',
      target: { type: 'permission', value: 'LOG_SUPER' },
    }));
  });
});

describe('POST /counts/:id/reopen', () => {
  test('is rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).post('/counts/1/reopen');
    expect(res.status).toBe(403);
  });

  test('400s when the count is not Rejected', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 1, Status: 'Open' });
    const res = await request(appLogSuper).post('/counts/1/reopen');
    expect(res.status).toBe(400);
  });

  test('reopens a rejected count', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 1, Status: 'Rejected' });
    db.updateCountStatus.mockResolvedValueOnce(true);
    const res = await request(appLogSuper).post('/counts/1/reopen');
    expect(res.status).toBe(200);
    expect(db.updateCountStatus).toHaveBeenCalledWith('1', 'Open', expect.objectContaining({ reopenedBy: logSuperUser.username }));
  });
});

describe('GET /counts/:id/report', () => {
  test('defaults to grouped-by-material', async () => {
    db.getCountReportByMaterial.mockResolvedValueOnce([{ Material: 'A' }]);
    const res = await request(app).get('/counts/1/report');
    expect(res.body.data).toEqual([{ Material: 'A' }]);
    expect(db.getCountReportByMaterialAndBin).not.toHaveBeenCalled();
  });

  test('groupBy=bin uses the material+bin breakdown', async () => {
    db.getCountReportByMaterialAndBin.mockResolvedValueOnce([{ Material: 'A', Bin: 'B01' }]);
    const res = await request(app).get('/counts/1/report?groupBy=bin');
    expect(res.body.data).toEqual([{ Material: 'A', Bin: 'B01' }]);
  });
});

// ── Finished Goods Count ────────────────────────────────────────────────────────

describe('GET /fg/session/current', () => {
  test('returns the active session or null', async () => {
    db.getActiveFgSession.mockResolvedValueOnce({ CountId: 5, Status: 'Open' });
    const res = await request(app).get('/fg/session/current');
    expect(res.body.data).toEqual({ CountId: 5, Status: 'Open' });
  });
});

describe('POST /fg/session/start', () => {
  test('is rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).post('/fg/session/start').send({ storageLocation: '1000' });
    expect(res.status).toBe(403);
  });

  test('400s without a storageLocation', async () => {
    const res = await request(appLogSuper).post('/fg/session/start').send({});
    expect(res.status).toBe(400);
  });

  test('400s when a session is already open', async () => {
    db.getActiveFgSession.mockResolvedValueOnce({ CountId: 5 });
    const res = await request(appLogSuper).post('/fg/session/start').send({ storageLocation: '1000' });
    expect(res.status).toBe(400);
    expect(db.createCountDocument).not.toHaveBeenCalled();
  });

  test('starts a session', async () => {
    db.getActiveFgSession.mockResolvedValueOnce(null);
    db.createCountDocument.mockResolvedValueOnce(6);
    const res = await request(appLogSuper).post('/fg/session/start').send({ storageLocation: '1000' });
    expect(res.status).toBe(200);
    expect(db.createCountDocument).toHaveBeenCalledWith(expect.objectContaining({ countType: 'FINISHED_GOODS', storageLocation: '1000' }));
  });
});

describe('POST /fg/session/:id/end', () => {
  test('is rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).post('/fg/session/5/end');
    expect(res.status).toBe(403);
  });

  test('404s when not a Finished Goods session', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 5, CountType: 'RAW_MATERIAL', Status: 'Open' });
    const res = await request(appLogSuper).post('/fg/session/5/end');
    expect(res.status).toBe(404);
  });

  test('400s when already closed', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 5, CountType: 'FINISHED_GOODS', Status: 'Closed' });
    const res = await request(appLogSuper).post('/fg/session/5/end');
    expect(res.status).toBe(400);
  });

  test('ends the session', async () => {
    db.getCountDocument.mockResolvedValueOnce({ CountId: 5, CountType: 'FINISHED_GOODS', Status: 'Open' });
    db.updateCountStatus.mockResolvedValueOnce(true);
    const res = await request(appLogSuper).post('/fg/session/5/end');
    expect(res.status).toBe(200);
    expect(db.updateCountStatus).toHaveBeenCalledWith('5', 'Closed', expect.objectContaining({ submittedBy: logSuperUser.username }));
  });
});

describe('GET /fg/batches', () => {
  test('400s when no session is open', async () => {
    db.getActiveFgSession.mockResolvedValueOnce(null);
    const res = await request(app).get('/fg/batches');
    expect(res.status).toBe(400);
  });

  test('filters to batch-managed rows only', async () => {
    db.getActiveFgSession.mockResolvedValueOnce({ CountId: 5, StorageLocation: '1000' });
    axiosMock.get.mockResolvedValueOnce({ data: { success: true, data: [
      { material: 'A', batch: 'B1' }, { material: 'B', batch: '' }, { material: 'C', batch: null },
    ] } });
    const res = await request(app).get('/fg/batches');
    expect(res.body.data).toEqual([{ material: 'A', batch: 'B1' }]);
    expect(axiosMock.get.mock.calls[0][1].params).toMatchObject({ storageLocation: '1000' });
  });
});

describe('POST /fg/scan', () => {
  test('400s without all required fields', async () => {
    const res = await request(app).post('/fg/scan').send({ material: 'A', batch: 'B1' });
    expect(res.status).toBe(400);
  });

  test('CorrectBin: found in the exact scanned bin, no discrepancy created', async () => {
    axiosMock.get.mockResolvedValueOnce({ data: { success: true, data: [{ material: 'A', batch: 'B1', storageType: 'FG1', bin: 'B01' }] } });
    db.recordFgScan.mockResolvedValueOnce(101);
    db.findOpenDiscrepancy.mockResolvedValueOnce(null);

    const res = await request(app).post('/fg/scan').send({ material: 'A', batch: 'B1', scannedStorageType: 'FG1', scannedBin: 'B01' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ outcome: 'CorrectBin' });
    expect(db.recordFgScan).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'CorrectBin', expectedFound: true }));
    expect(db.createDiscrepancy).not.toHaveBeenCalled();
  });

  test('WrongBin: not found in the scanned bin, creates a discrepancy with SAP\'s real expected bin, and notifies LOG_SUPER', async () => {
    axiosMock.get
      .mockResolvedValueOnce({ data: { success: true, data: [] } }) // exact scanned bin — not found
      .mockResolvedValueOnce({ data: { success: true, data: [{ material: 'A', batch: 'B1', storageType: 'FG1', bin: 'B02' }] } }); // anywhere lookup
    db.recordFgScan.mockResolvedValueOnce(102);
    db.findOpenDiscrepancy.mockResolvedValueOnce(null);
    db.createDiscrepancy.mockResolvedValueOnce(55);

    const res = await request(app).post('/fg/scan').send({ material: 'A', batch: 'B1', scannedStorageType: 'FG1', scannedBin: 'B03' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ outcome: 'WrongBin', expectedStorageType: 'FG1', expectedBin: 'B02' });
    expect(db.createDiscrepancy).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'WrongBin', expectedStorageType: 'FG1', expectedBin: 'B02', foundStorageType: 'FG1', foundBin: 'B03', sourceScanId: 102,
    }));
    expect(notifyMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ target: { type: 'permission', value: 'LOG_SUPER' } }));
  });

  test('auto-resolves a prior open discrepancy for the same batch regardless of this scan\'s outcome', async () => {
    axiosMock.get.mockResolvedValueOnce({ data: { success: true, data: [{ material: 'A', batch: 'B1' }] } });
    db.recordFgScan.mockResolvedValueOnce(103);
    db.findOpenDiscrepancy.mockResolvedValueOnce({ DiscrepancyId: 9 });

    await request(app).post('/fg/scan').send({ material: 'A', batch: 'B1', scannedStorageType: 'FG1', scannedBin: 'B01' });

    expect(db.resolveDiscrepancy).toHaveBeenCalledWith(9, 'ResolvedFoundLater', expect.objectContaining({ resolvedBy: 'j.smith' }));
  });
});

describe('POST /fg/bins/:storageType/:bin/confirm', () => {
  test('creates a Missing discrepancy + scan row for every SAP-expected batch not confirmed in this bin', async () => {
    axiosMock.get.mockResolvedValueOnce({ data: { success: true, data: [
      { material: 'A', batch: 'B1' }, { material: 'B', batch: 'B2' }, { material: 'C', batch: '' },
    ] } });
    db.listConfirmedBatchesInBin.mockResolvedValueOnce([{ Material: 'A', Batch: 'B1' }]); // only A/B1 confirmed
    db.recordFgScan.mockResolvedValue(201);
    db.createDiscrepancy.mockResolvedValue(77);

    const res = await request(app).post('/fg/bins/FG1/B01/confirm');

    expect(res.status).toBe(200);
    expect(res.body.data.missingCount).toBe(1);
    expect(db.recordFgScan).toHaveBeenCalledWith(expect.objectContaining({ material: 'B', batch: 'B2', outcome: 'MissingFromBin' }));
    expect(db.createDiscrepancy).toHaveBeenCalledWith(expect.objectContaining({ material: 'B', batch: 'B2', kind: 'Missing', expectedStorageType: 'FG1', expectedBin: 'B01' }));
  });
});

describe('GET /discrepancies', () => {
  test('lists open discrepancies', async () => {
    db.listOpenDiscrepancies.mockResolvedValueOnce([{ DiscrepancyId: 1 }]);
    const res = await request(app).get('/discrepancies');
    expect(res.body.data).toEqual([{ DiscrepancyId: 1 }]);
  });
});

describe('POST /discrepancies/:id/resolve-move', () => {
  test('is rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).post('/discrepancies/1/resolve-move');
    expect(res.status).toBe(403);
  });

  test('404s when there is no open discrepancy', async () => {
    db.getDiscrepancy.mockResolvedValueOnce(null);
    const res = await request(appLogSuper).post('/discrepancies/1/resolve-move');
    expect(res.status).toBe(404);
  });

  test('400s for a Missing-kind discrepancy (must use resolve-holding)', async () => {
    db.getDiscrepancy.mockResolvedValueOnce({ DiscrepancyId: 1, Status: 'Open', Kind: 'Missing' });
    const res = await request(appLogSuper).post('/discrepancies/1/resolve-move');
    expect(res.status).toBe(400);
  });

  test('422s when SAP no longer shows the batch at the expected source', async () => {
    db.getDiscrepancy.mockResolvedValueOnce({ DiscrepancyId: 1, Status: 'Open', Kind: 'WrongBin', Material: 'A', Batch: 'B1', ExpectedStorageType: 'FG1', ExpectedBin: 'B01', FoundStorageType: 'FG1', FoundBin: 'B02' });
    axiosMock.get.mockResolvedValueOnce({ data: { success: true, data: [] } });
    const res = await request(appLogSuper).post('/discrepancies/1/resolve-move');
    expect(res.status).toBe(422);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('creates the transfer order directly against SapServer (bypassing the Nexus guard proxy) and marks resolved', async () => {
    db.getDiscrepancy.mockResolvedValueOnce({ DiscrepancyId: 1, Status: 'Open', Kind: 'WrongBin', Material: 'A', Batch: 'B1', ExpectedStorageType: 'FG1', ExpectedBin: 'B01', FoundStorageType: 'FG1', FoundBin: 'B02' });
    axiosMock.get.mockResolvedValueOnce({ data: { success: true, data: [{ storageLocation: '1000', availableQty: 40 }] } });
    axiosMock.post.mockResolvedValueOnce({ data: { success: true, data: { transferOrderNumber: 'TO900' } } });
    db.resolveDiscrepancy.mockResolvedValueOnce(true);

    const res = await request(appLogSuper).post('/discrepancies/1/resolve-move');

    expect(res.status).toBe(200);
    expect(axiosMock.post.mock.calls[0][0]).toContain('/api/warehouse/transfer-order');
    expect(axiosMock.post.mock.calls[0][1]).toMatchObject({
      Material: 'A', Batch: 'B1', StorageLocation: '1000', Quantity: 40,
      SourceType: 'FG1', SourceBin: 'B01', DestinationType: 'FG1', DestinationBin: 'B02',
    });
    expect(db.resolveDiscrepancy).toHaveBeenCalledWith('1', 'ResolvedMoved', expect.objectContaining({ resolutionTransferOrderNumber: 'TO900' }));
  });
});

describe('POST /discrepancies/:id/resolve-holding', () => {
  test('moves to SAP bin type 999 / bin TEMP', async () => {
    db.getDiscrepancy.mockResolvedValueOnce({ DiscrepancyId: 2, Status: 'Open', Kind: 'Missing', Material: 'A', Batch: 'B1', ExpectedStorageType: 'FG1', ExpectedBin: 'B01' });
    axiosMock.get.mockResolvedValueOnce({ data: { success: true, data: [{ storageLocation: '1000', availableQty: 10 }] } });
    axiosMock.post.mockResolvedValueOnce({ data: { success: true, data: { transferOrderNumber: 'TO901' } } });
    db.resolveDiscrepancy.mockResolvedValueOnce(true);

    const res = await request(appLogSuper).post('/discrepancies/2/resolve-holding');

    expect(res.status).toBe(200);
    expect(axiosMock.post.mock.calls[0][1]).toMatchObject({ DestinationType: '999', DestinationBin: 'TEMP' });
    expect(db.resolveDiscrepancy).toHaveBeenCalledWith('2', 'ResolvedHolding', expect.anything());
  });
});

describe('POST /discrepancies/:id/manual-to', () => {
  test('400s without destination fields', async () => {
    const res = await request(appLogSuper).post('/discrepancies/1/manual-to').send({});
    expect(res.status).toBe(400);
  });

  test('creates a TO to the supervisor-confirmed destination', async () => {
    db.getDiscrepancy.mockResolvedValueOnce({ DiscrepancyId: 3, Status: 'Open', Kind: 'Missing', Material: 'A', Batch: 'B1', ExpectedStorageType: 'FG1', ExpectedBin: 'B01' });
    axiosMock.get.mockResolvedValueOnce({ data: { success: true, data: [{ storageLocation: '1000', availableQty: 5 }] } });
    axiosMock.post.mockResolvedValueOnce({ data: { success: true, data: { transferOrderNumber: 'TO902' } } });
    db.resolveDiscrepancy.mockResolvedValueOnce(true);

    const res = await request(appLogSuper).post('/discrepancies/3/manual-to').send({ destinationStorageType: 'FG1', destinationBin: 'B09' });

    expect(res.status).toBe(200);
    expect(axiosMock.post.mock.calls[0][1]).toMatchObject({ DestinationType: 'FG1', DestinationBin: 'B09' });
    expect(db.resolveDiscrepancy).toHaveBeenCalledWith('3', 'ResolvedMoved', expect.objectContaining({ resolutionTransferOrderNumber: 'TO902' }));
  });
});
