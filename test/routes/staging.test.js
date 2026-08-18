// routes/staging.js (Staging Post) delegates persistence to stagingsql.js
// (`db`, mocked wholesale) and SAP stock lookups to SapServer via axios
// directly (not through routes/sap.js's proxies). Covers the CRUD/
// validation surface, the Needed-By lead-time rule, the bin-restriction
// isAllowed logic on the stock-lookup route, and the LOG_SUPER gate on
// bin-restriction management, plus (see the POST /requests/:id/deliver
// describe block near the end) the consignment-vs-transfer-order branching,
// SAP-rejection handling at both the axios-throw and business-level-
// success:false layers, and the audit/redrum-reversal side effects on a
// successful delivery.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const db = {
  searchMaterials: jest.fn(),
  listOpenStagingRequests: jest.fn(),
  getStagingOpenSummary: jest.fn(),
  listStagingRequests: jest.fn(),
  listCompletedStagingRequests: jest.fn(),
  getStagingRequestById: jest.fn(),
  listStagingRequestDeliveries: jest.fn(),
  createStagingRequest: jest.fn(),
  cancelStagingRequest: jest.fn(),
  completeStagingRequest: jest.fn(),
  getBinRestrictionsForMaterial: jest.fn(),
  listBinRestrictions: jest.fn(),
  createBinRestriction: jest.fn(),
  updateBinRestriction: jest.fn(),
  deleteBinRestriction: jest.fn(),
  bulkImportBinRestrictions: jest.fn(),
  recordStagingDelivery: jest.fn(),
};
jest.unstable_mockModule('../../routes/stagingsql.js', () => db);

const axiosMock = { get: jest.fn(), post: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

const maybeReverseBatchManagedReturnMock = jest.fn();
jest.unstable_mockModule('../../lib/redrumReversal.js', () => ({
  maybeReverseBatchManagedReturn: maybeReverseBatchManagedReturnMock,
}));

const getConversionQtyMock = jest.fn();
jest.unstable_mockModule('../../routes/materialRequestUnits.js', () => ({
  getConversionQty: getConversionQtyMock,
}));

const logSuperUser = { ...operatorUser, permissions: ['LOG_SUPER'] };

let stagingRouter;
let app;
let appLogSuper;

beforeAll(async () => {
  ({ default: stagingRouter } = await import('../../routes/staging.js'));
  app = buildTestApp(stagingRouter, { sessionUser: operatorUser });
  appLogSuper = buildTestApp(stagingRouter, { sessionUser: logSuperUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  Object.values(db).forEach(fn => fn.mockReset());
  axiosMock.get.mockReset();
  axiosMock.post.mockReset();
  maybeReverseBatchManagedReturnMock.mockReset();
  getConversionQtyMock.mockReset();
  dbRequest.query.mockResolvedValue({ recordset: [] }); // audit()/notify() default to succeeding
});

function auditedEventTypes() {
  return dbRequest.input.mock.calls.filter(c => c[0] === 'eventType').map(c => c[2]);
}

describe('GET /materials', () => {
  test('short-circuits on an empty search term without calling the DB', async () => {
    const res = await request(app).get('/materials');
    expect(res.body).toEqual({ success: true, data: [] });
    expect(db.searchMaterials).not.toHaveBeenCalled();
  });

  test('searches when given a term', async () => {
    db.searchMaterials.mockResolvedValueOnce([{ Material: '30005R' }]);
    const res = await request(app).get('/materials?search=3000');
    expect(res.body.data).toEqual([{ Material: '30005R' }]);
  });

  // The request form's main search box only ever matches part numbers; the
  // separate description box is the only way to search MaterialText — see
  // stagingsql.js's searchMaterials(search, by).
  test('defaults to a material-only search when `by` is omitted', async () => {
    db.searchMaterials.mockResolvedValueOnce([]);
    await request(app).get('/materials?search=drum');
    expect(db.searchMaterials).toHaveBeenCalledWith('drum', 'material');
  });

  test('searches by description when by=description', async () => {
    db.searchMaterials.mockResolvedValueOnce([]);
    await request(app).get('/materials?search=drum&by=description');
    expect(db.searchMaterials).toHaveBeenCalledWith('drum', 'description');
  });

  test('an unrecognised `by` value still falls back to material', async () => {
    db.searchMaterials.mockResolvedValueOnce([]);
    await request(app).get('/materials?search=drum&by=bogus');
    expect(db.searchMaterials).toHaveBeenCalledWith('drum', 'material');
  });
});

describe('GET /requests/:id', () => {
  test('404s when the request does not exist', async () => {
    db.getStagingRequestById.mockResolvedValueOnce(null);
    const res = await request(app).get('/requests/999');
    expect(res.status).toBe(404);
  });

  test('includes deliveries alongside the request', async () => {
    db.getStagingRequestById.mockResolvedValueOnce({ RequestID: 1, Material: '30005R' });
    db.listStagingRequestDeliveries.mockResolvedValueOnce([{ DeliveryID: 1 }]);
    const res = await request(app).get('/requests/1');
    expect(res.body.data.deliveries).toEqual([{ DeliveryID: 1 }]);
  });
});

describe('POST /requests — validation', () => {
  // Frozen at a Monday midday so the Stores-working-hours lead-time check
  // (05:45–17:00 Mon–Fri, see routes/staging.js's addStoresLeadTime) always
  // has the same "now" to compute from — a real-clock evening/weekend run
  // would otherwise push the minimum well past the +8h padding below.
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-05T12:00:00.000Z')); // a Monday
  });
  afterEach(() => { jest.useRealTimers(); });

  const validBody = () => ({
    material: '30005R',
    quantityRequested: 10,
    location: 'Line 1',
    dueAtUtc: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
  });

  test('requires material', async () => {
    const res = await request(app).post('/requests').send({ ...validBody(), material: '' });
    expect(res.status).toBe(400);
  });

  test('requires a positive quantityRequested', async () => {
    const res = await request(app).post('/requests').send({ ...validBody(), quantityRequested: 0 });
    expect(res.status).toBe(400);
  });

  test('requires location', async () => {
    const res = await request(app).post('/requests').send({ ...validBody(), location: '' });
    expect(res.status).toBe(400);
  });

  test('requires dueAtUtc', async () => {
    const res = await request(app).post('/requests').send({ ...validBody(), dueAtUtc: '' });
    expect(res.status).toBe(400);
  });

  test('rejects a dueAtUtc less than the minimum lead time from now', async () => {
    const res = await request(app).post('/requests').send({ ...validBody(), dueAtUtc: new Date(Date.now() + 30 * 60000).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/at least 4 working hours/);
  });

  // Monday 15:00 is within Stores hours, but 15:00 + 4h = 19:00 is past the
  // 17:00 close — the overflow (2h) should roll over to 05:45 the next
  // working day, landing the minimum at 07:45 Tuesday (07:40 once the
  // 5-minute submission grace period is subtracted) rather than 19:00.
  test('rolls a lead time that would land after 17:00 over to the next working day', async () => {
    jest.setSystemTime(new Date('2026-01-05T15:00:00.000Z')); // Monday 15:00
    const res = await request(app).post('/requests').send({
      ...validBody(), dueAtUtc: new Date('2026-01-06T07:39:00.000Z').toISOString(), // just before the 07:40 grace boundary
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/07:40/);
  });

  // A request raised outside working hours (here, a Saturday) counts its
  // 4-hour lead time from the next working day's 05:45 open — Monday, since
  // Stores run no weekend shift — landing the minimum at 09:45 Monday
  // (09:40 once the 5-minute submission grace period is subtracted).
  test('counts the lead time from the next working day\'s open when raised at the weekend', async () => {
    jest.setSystemTime(new Date('2026-01-03T10:00:00.000Z')); // Saturday
    const res = await request(app).post('/requests').send({
      ...validBody(), dueAtUtc: new Date('2026-01-05T09:39:00.000Z').toISOString(), // just before the 09:40 grace boundary
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/09:40/);
  });

  // Regression coverage: a dueAtUtc outside Stores' working hours must not
  // sail through just because it's far enough in the future — the lead-time
  // check alone doesn't catch that. It must be snapped into the window
  // instead of accepted as-is.
  describe('snapping a dueAtUtc outside Stores\' working hours', () => {
    beforeEach(() => {
      jest.setSystemTime(new Date('2026-01-05T08:00:00.000Z')); // Monday 08:00 — plenty of lead time either way
    });

    // 20:00 Monday is 3 hours after the 17:00 close — within the 4-hour
    // "assume same day" threshold, so it should revert to end of shift.
    test('reverts to end of shift when the pick is within the 4-hour threshold past close', async () => {
      db.createStagingRequest.mockResolvedValueOnce(200);
      const res = await request(app).post('/requests').send({
        ...validBody(), dueAtUtc: new Date('2026-01-05T20:00:00.000Z').toISOString(), // Monday 20:00
      });
      expect(res.status).toBe(200);
      expect(res.body.data.dueAtUtc).toBe('2026-01-05T17:00:00.000Z');
      expect(db.createStagingRequest).toHaveBeenCalledWith(expect.objectContaining({
        dueAtUtc: new Date('2026-01-05T17:00:00.000Z'),
      }));
    });

    // 22:00 Monday is 5 hours after the 17:00 close — past the threshold,
    // so it should move to the start of the next working day instead.
    test('moves to the start of the next shift when the pick is further past close', async () => {
      db.createStagingRequest.mockResolvedValueOnce(201);
      const res = await request(app).post('/requests').send({
        ...validBody(), dueAtUtc: new Date('2026-01-05T22:00:00.000Z').toISOString(), // Monday 22:00
      });
      expect(res.status).toBe(200);
      expect(res.body.data.dueAtUtc).toBe('2026-01-06T05:45:00.000Z'); // Tuesday 05:45
    });

    // A weekend pick, even with ample notice, has no shift to snap back
    // to (no weekend shift) — it always moves forward to the next Monday.
    test('moves a weekend pick forward to the next Monday\'s open', async () => {
      db.createStagingRequest.mockResolvedValueOnce(202);
      const res = await request(app).post('/requests').send({
        ...validBody(), dueAtUtc: new Date('2026-01-10T12:00:00.000Z').toISOString(), // Saturday
      });
      expect(res.status).toBe(200);
      expect(res.body.data.dueAtUtc).toBe('2026-01-12T05:45:00.000Z'); // the following Monday 05:45
    });

    // A pick already inside the working window is untouched.
    test('leaves a dueAtUtc already inside the working window unchanged', async () => {
      db.createStagingRequest.mockResolvedValueOnce(203);
      const res = await request(app).post('/requests').send({
        ...validBody(), dueAtUtc: new Date('2026-01-05T14:30:00.000Z').toISOString(), // Monday 14:30
      });
      expect(res.status).toBe(200);
      expect(res.body.data.dueAtUtc).toBe('2026-01-05T14:30:00.000Z');
    });
  });

  test('creates the request when valid', async () => {
    db.createStagingRequest.mockResolvedValueOnce(123);
    const res = await request(app).post('/requests').send(validBody());
    expect(res.status).toBe(200);
    expect(res.body.data.requestId).toBe(123);
  });
});

// Unit-based requests ("1 Spool") — the KG figure sent to
// db.createStagingRequest must always come from the server-side
// log.MaterialRequestUnits lookup (getConversionQty), never from a
// client-supplied quantityRequested, since the unit dropdown's conversion
// factor is only ever a client-side preview.
describe('POST /requests — unit conversion', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-05T12:00:00.000Z')); // a Monday
  });
  afterEach(() => { jest.useRealTimers(); });

  const unitBody = () => ({
    material: '30007R',
    requestUnit: 'Spool',
    requestUnitQty: 1,
    location: 'Extrusion',
    dueAtUtc: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
  });

  test('converts requestUnitQty to KG via getConversionQty and ignores any client-sent quantityRequested', async () => {
    getConversionQtyMock.mockResolvedValueOnce(20);
    db.createStagingRequest.mockResolvedValueOnce(456);

    const res = await request(app).post('/requests').send({ ...unitBody(), quantityRequested: 999999 });

    expect(res.status).toBe(200);
    expect(getConversionQtyMock).toHaveBeenCalledWith('30007R', 'Spool');
    expect(db.createStagingRequest).toHaveBeenCalledWith(expect.objectContaining({
      quantityRequested: 20, requestUnit: 'Spool', requestUnitQty: 1,
    }));
  });

  test('multiplies conversionQty by requestUnitQty for quantities greater than 1', async () => {
    getConversionQtyMock.mockResolvedValueOnce(20);
    db.createStagingRequest.mockResolvedValueOnce(457);

    const res = await request(app).post('/requests').send({ ...unitBody(), requestUnitQty: 3 });

    expect(res.status).toBe(200);
    expect(db.createStagingRequest).toHaveBeenCalledWith(expect.objectContaining({ quantityRequested: 60 }));
  });

  test('400s when requestUnitQty is zero/negative', async () => {
    const res = await request(app).post('/requests').send({ ...unitBody(), requestUnitQty: 0 });
    expect(res.status).toBe(400);
    expect(getConversionQtyMock).not.toHaveBeenCalled();
    expect(db.createStagingRequest).not.toHaveBeenCalled();
  });

  test('400s with the conversion lookup\'s own message when no conversion is configured', async () => {
    getConversionQtyMock.mockRejectedValueOnce(new Error('No conversion configured for Spool of 30007R.'));
    const res = await request(app).post('/requests').send(unitBody());
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/No conversion configured/);
    expect(db.createStagingRequest).not.toHaveBeenCalled();
  });

  test('does not require quantityRequested when a requestUnit is supplied', async () => {
    getConversionQtyMock.mockResolvedValueOnce(20);
    db.createStagingRequest.mockResolvedValueOnce(458);
    const res = await request(app).post('/requests').send(unitBody()); // no quantityRequested at all
    expect(res.status).toBe(200);
  });
});

describe('POST /requests/:id/cancel', () => {
  test('400s when the request can no longer be cancelled', async () => {
    db.cancelStagingRequest.mockResolvedValueOnce(false);
    const res = await request(app).post('/requests/1/cancel');
    expect(res.status).toBe(400);
  });

  test('cancels successfully', async () => {
    db.cancelStagingRequest.mockResolvedValueOnce(true);
    const res = await request(app).post('/requests/1/cancel');
    expect(res.status).toBe(200);
  });
});

describe('GET /requests/:id/stock — bin-restriction isAllowed logic', () => {
  test('every bin is allowed when no restrictions are configured for the material', async () => {
    db.getStagingRequestById.mockResolvedValueOnce({ Material: '30005R', RequestedBatch: null });
    db.getBinRestrictionsForMaterial.mockResolvedValueOnce([]);
    axiosMock.get.mockResolvedValueOnce({ data: { success: true, data: [{ storageType: 'SA', bin: 'BIN-999' }] } });

    const res = await request(app).get('/requests/1/stock');

    expect(res.body.data.hasRestrictions).toBe(false);
    expect(res.body.data.stock[0].isAllowed).toBe(true);
  });

  test('flags a bin not matching any configured restriction as not allowed', async () => {
    db.getStagingRequestById.mockResolvedValueOnce({ Material: '30005R', RequestedBatch: null });
    db.getBinRestrictionsForMaterial.mockResolvedValueOnce([{ StorageType: 'SA', Bin: 'BIN-001' }]);
    axiosMock.get.mockResolvedValueOnce({
      data: { success: true, data: [{ storageType: 'SA', bin: 'BIN-999' }, { storageType: 'SA', bin: 'BIN-001' }] },
    });

    const res = await request(app).get('/requests/1/stock');

    expect(res.body.data.stock[0].isAllowed).toBe(false); // BIN-999 doesn't match
    expect(res.body.data.stock[1].isAllowed).toBe(true);  // BIN-001 matches exactly
  });

  test('a restriction with no specific Bin allows any bin of that storage type', async () => {
    db.getStagingRequestById.mockResolvedValueOnce({ Material: '30005R', RequestedBatch: null });
    db.getBinRestrictionsForMaterial.mockResolvedValueOnce([{ StorageType: 'SA', Bin: null }]);
    axiosMock.get.mockResolvedValueOnce({ data: { success: true, data: [{ storageType: 'SA', bin: 'ANY-BIN' }] } });

    const res = await request(app).get('/requests/1/stock');

    expect(res.body.data.stock[0].isAllowed).toBe(true);
  });
});

describe('bin-restrictions — LOG_SUPER gate', () => {
  test('POST is rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).post('/bin-restrictions').send({ material: '30005R', storageType: 'SA' });
    expect(res.status).toBe(403);
    expect(db.createBinRestriction).not.toHaveBeenCalled();
  });

  test('POST succeeds for a LOG_SUPER user', async () => {
    db.createBinRestriction.mockResolvedValueOnce(5);
    const res = await request(appLogSuper).post('/bin-restrictions').send({ material: '30005R', storageType: 'SA' });
    expect(res.status).toBe(200);
  });

  test('DELETE is rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).delete('/bin-restrictions/1');
    expect(res.status).toBe(403);
  });
});

describe('POST /bin-restrictions/bulk — CSV import', () => {
  test('rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).post('/bin-restrictions/bulk').send({ records: [{ material: '30005R', storageType: 'SA' }] });
    expect(res.status).toBe(403);
    expect(db.bulkImportBinRestrictions).not.toHaveBeenCalled();
  });

  test('400s when records is missing or empty', async () => {
    const res1 = await request(appLogSuper).post('/bin-restrictions/bulk').send({});
    expect(res1.status).toBe(400);
    const res2 = await request(appLogSuper).post('/bin-restrictions/bulk').send({ records: [] });
    expect(res2.status).toBe(400);
    expect(db.bulkImportBinRestrictions).not.toHaveBeenCalled();
  });

  test('delegates to db.bulkImportBinRestrictions and returns its summary', async () => {
    db.bulkImportBinRestrictions.mockResolvedValueOnce({ inserted: 2, skipped: 1, errors: [] });
    const records = [
      { material: '30005R', storageType: 'SA', bin: 'BIN-001', notes: null },
      { material: '30006R', storageType: 'SB', bin: null, notes: 'x' },
    ];
    const res = await request(appLogSuper).post('/bin-restrictions/bulk').send({ records });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, inserted: 2, skipped: 1, errors: [] });
    expect(db.bulkImportBinRestrictions).toHaveBeenCalledWith(records, expect.any(String));
  });
});

describe('POST /requests/:id/deliver', () => {
  const openRequest = { RequestID: 1, Material: '30005R', RequestedBatch: 'B1', Status: 'Open' };
  const validBody = {
    quantity: 10, storageLocation: '1000',
    sourceStorageType: 'PDR', sourceBin: 'B01',
    destinationStorageType: 'SA', destinationBin: 'B02',
  };

  test('404s when the request does not exist', async () => {
    db.getStagingRequestById.mockResolvedValueOnce(null);
    const res = await request(app).post('/requests/999/deliver').send(validBody);
    expect(res.status).toBe(404);
  });

  test('400s when the request is no longer open', async () => {
    db.getStagingRequestById.mockResolvedValueOnce({ ...openRequest, Status: 'Delivered' });
    const res = await request(app).post('/requests/1/deliver').send(validBody);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/no longer open/);
  });

  test('400s on a zero/negative quantity', async () => {
    db.getStagingRequestById.mockResolvedValueOnce(openRequest);
    const res = await request(app).post('/requests/1/deliver').send({ ...validBody, quantity: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/quantity/);
  });

  test('400s when a required bin/type/location field is missing', async () => {
    db.getStagingRequestById.mockResolvedValueOnce(openRequest);
    const res = await request(app).post('/requests/1/deliver').send({ ...validBody, destinationBin: undefined });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Storage location, source bin\/type and destination bin\/type/);
  });

  test('400s on consignment stock (SOBKZ K into SA) with no special stock number', async () => {
    db.getStagingRequestById.mockResolvedValueOnce(openRequest);
    const res = await request(app).post('/requests/1/deliver').send({ ...validBody, specialStockIndicator: 'K' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/consignment stock/);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  // lib/stockCountGuard.js — Staging Post calls SapServer's transfer-order
  // endpoint directly (not through routes/sap.js's proxy), so this guard is
  // wired into createSapTransferOrder itself rather than inherited.
  test('422s and audits STAGING_DELIVER_SAP_ERROR when an active count blocks the storage location', async () => {
    db.getStagingRequestById.mockResolvedValueOnce(openRequest);
    dbRequest.query.mockResolvedValueOnce({
      recordset: [{ CountId: 3, CountType: 'RAW_MATERIAL', Status: 'Open' }],
    });

    const res = await request(app).post('/requests/1/deliver').send(validBody);

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/RAW_MATERIAL count #3/);
    expect(axiosMock.post).not.toHaveBeenCalled();
    expect(auditedEventTypes()).toEqual(['STAGING_DELIVER_SAP_ERROR']);
    expect(db.recordStagingDelivery).not.toHaveBeenCalled();
  });

  test('422s and audits STAGING_DELIVER_SAP_ERROR when the SAP call itself throws', async () => {
    db.getStagingRequestById.mockResolvedValueOnce(openRequest);
    axiosMock.post.mockRejectedValueOnce(new Error('RFC timeout'));
    const res = await request(app).post('/requests/1/deliver').send(validBody);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/SAP rejected the transfer order: RFC timeout/);
    expect(auditedEventTypes()).toEqual(['STAGING_DELIVER_SAP_ERROR']);
    expect(db.recordStagingDelivery).not.toHaveBeenCalled();
  });

  test('422s with SAP\'s own messages when the transfer order itself reports failure (business-level, not the envelope)', async () => {
    db.getStagingRequestById.mockResolvedValueOnce(openRequest);
    axiosMock.post.mockResolvedValueOnce({
      data: { success: true, data: { success: false, messages: [{ type: 'E', message: 'Bin is full' }] } },
    });
    const res = await request(app).post('/requests/1/deliver').send(validBody);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Bin is full');
    expect(res.body.data.messages).toEqual([{ type: 'E', message: 'Bin is full' }]);
  });

  test('creates a standard transfer order, records the delivery, and audits STAGING_DELIVERED', async () => {
    db.getStagingRequestById.mockResolvedValueOnce(openRequest);
    axiosMock.post.mockResolvedValueOnce({
      data: { success: true, data: { success: true, transferOrderNumber: 'TO123', messages: [] } },
    });
    db.recordStagingDelivery.mockResolvedValueOnce({ deliveryID: 5 });
    maybeReverseBatchManagedReturnMock.mockResolvedValueOnce(null);

    const res = await request(app).post('/requests/1/deliver').send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ transferOrderNumber: 'TO123', deliveryID: 5 });
    expect(db.recordStagingDelivery).toHaveBeenCalledWith('1', expect.objectContaining({
      quantityMoved: 10, batch: 'B1', transferOrderNumber: 'TO123',
    }));
    expect(axiosMock.post.mock.calls[0][0]).toContain('/api/warehouse/transfer-order');
    expect(auditedEventTypes()).toEqual(['STAGING_DELIVERED']);
    expect(res.body.data.redrum).toBeUndefined();
  });

  test('includes the redrum result in the response when a batch-managed return was reversed', async () => {
    db.getStagingRequestById.mockResolvedValueOnce(openRequest);
    axiosMock.post.mockResolvedValueOnce({
      data: { success: true, data: { success: true, transferOrderNumber: 'TO124', messages: [] } },
    });
    db.recordStagingDelivery.mockResolvedValueOnce({});
    maybeReverseBatchManagedReturnMock.mockResolvedValueOnce({ reversed: true, note: 'Return RD1 reversed' });

    const res = await request(app).post('/requests/1/deliver').send(validBody);

    expect(res.body.data.redrum).toEqual({ reversed: true, note: 'Return RD1 reversed' });
  });

  test('routes consignment stock (SOBKZ K into SA) through the MB1B endpoint instead of a transfer order', async () => {
    db.getStagingRequestById.mockResolvedValueOnce(openRequest);
    axiosMock.post.mockResolvedValueOnce({
      data: { success: true, data: { success: true, mb1bMessage: 'S M7 011 MB1B posted', toNonConsignMessage: null, toConsignMessage: 'S M7 012 LT01 posted' } },
    });
    db.recordStagingDelivery.mockResolvedValueOnce({});
    maybeReverseBatchManagedReturnMock.mockResolvedValueOnce(null);

    const res = await request(app).post('/requests/1/deliver').send({
      ...validBody, specialStockIndicator: 'K', specialStockNumber: 'VENDOR1',
    });

    expect(res.status).toBe(200);
    expect(axiosMock.post.mock.calls[0][0]).toContain('/api/warehouse/consignment-mb1b');
    expect(res.body.data.transferOrderNumber).toBeNull(); // consignment issues have no transfer order number
    expect(res.body.data.messages).toEqual([
      { type: 'S', message: 'S M7 011 MB1B posted' },
      { type: 'S', message: 'S M7 012 LT01 posted' },
    ]);
    expect(db.recordStagingDelivery).toHaveBeenCalled();
    expect(auditedEventTypes()).toEqual(['STAGING_DELIVERED']);
  });

  // Regression test for the bug this whole describe block was written to
  // catch: SapServer previously always returned success:true for
  // consignment-mb1b, and this route hardcoded every message's type to 'S',
  // so a rejected MB1B (e.g. deficit stock) still looked like a successful
  // delivery and got recorded/audited as one — the stock never actually
  // left consignment in SAP. SapServer now returns a 422 (axios throws) when
  // any of the three BDC legs reports an SAP error; this route must treat
  // that the same way it already treats a rejected plain transfer order.
  test('422s and does not record a delivery when SAP rejects the MB1B leg (consignment stock never actually moved)', async () => {
    db.getStagingRequestById.mockResolvedValueOnce(openRequest);
    axiosMock.post.mockRejectedValueOnce({
      response: { status: 422, data: { success: false, error: { code: '422', message: 'E M7 021 Deficit of SL stock 5 PC : 30005R 1000 SA B02' } } },
    });

    const res = await request(app).post('/requests/1/deliver').send({
      ...validBody, specialStockIndicator: 'K', specialStockNumber: 'VENDOR1',
    });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/SAP rejected the consignment issue: E M7 021 Deficit of SL stock/);
    expect(auditedEventTypes()).toEqual(['STAGING_DELIVER_SAP_ERROR']);
    expect(db.recordStagingDelivery).not.toHaveBeenCalled();
  });
});
