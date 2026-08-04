// routes/deliverymain.js (1519 lines, 24 endpoints) — representative sample
// covering CRUD, the permission-gated create/bulk routes, and the
// packaging-holding cancel/uncomplete flows that reverse SAP staging via
// the shared cancelHeldPicksheet() helper. The picksheet-materials/complete/
// zdelflag routes (SAP-sync-heavy, largest remaining logic) aren't covered
// here yet — see CLAUDE.md.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

jest.unstable_mockModule('../../routes/sap.js', () => ({
  makeSapToken: jest.fn(() => 'fake-sap-token'),
  sapAgent: null,
}));

const reverseStagedPackageMock = jest.fn();
jest.unstable_mockModule('../../routes/sapStaging.js', () => ({
  reverseStagedPackage: reverseStagedPackageMock,
}));

const logSuperUser = { ...operatorUser, permissions: ['LOG_SUPER'] };

let deliveryRouter;
let app;
let appLogSuper;

beforeAll(async () => {
  ({ default: deliveryRouter } = await import('../../routes/deliverymain.js'));
  app = buildTestApp(deliveryRouter, { sessionUser: operatorUser });
  appLogSuper = buildTestApp(deliveryRouter, { sessionUser: logSuperUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  reverseStagedPackageMock.mockReset();
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET /', () => {
  test('returns the raw recordset', async () => {
    queueResults({ recordset: [{ deliveryID: 1 }, { deliveryID: 2 }] });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ deliveryID: 1 }, { deliveryID: 2 }]);
  });
});

describe('GET /id/:deliveryId', () => {
  test('returns an empty array when nothing matches', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).get('/id/999');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST / (create)', () => {
  test('is rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).post('/').send({ deliveryID: 1, customerID: 1 });
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('creates a delivery for a LOG_SUPER user', async () => {
    queueResults({ recordset: [] });
    const res = await request(appLogSuper).post('/').send({ deliveryID: 100, customerID: 5 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, deliveryID: 100 });
  });
});

describe('POST /bulk', () => {
  test('is rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).post('/bulk').send({ records: [{ deliveryID: 1 }] });
    expect(res.status).toBe(403);
  });

  test('rejects an empty records array', async () => {
    const res = await request(appLogSuper).post('/bulk').send({ records: [] });
    expect(res.status).toBe(400);
  });

  test('reports inserted vs skipped counts', async () => {
    queueResults(
      { rowsAffected: [1] }, // record 1 inserted
      { rowsAffected: [0] }, // record 2 already existed — skipped
    );
    const res = await request(appLogSuper).post('/bulk').send({
      records: [{ deliveryID: 1, customerID: 1 }, { deliveryID: 2, customerID: 1 }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, inserted: 1, skipped: 1, errors: [] });
  });
});

describe('DELETE /:deliveryId/packaging-holding', () => {
  test('404s when the delivery does not exist', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).delete('/999/packaging-holding');
    expect(res.status).toBe(404);
  });

  test('409s when the delivery is not actually pending packaging data', async () => {
    queueResults({ recordset: [{ pendingPackagingData: false }] });
    const res = await request(app).delete('/1/packaging-holding');
    expect(res.status).toBe(409);
  });

  test('422s and reports failures when a SAP staging reversal fails', async () => {
    queueResults(
      { recordset: [{ pendingPackagingData: true }] }, // pending check
      { recordset: [{ palletItemID: 10, sapMaterial: '30005R', sapBatch: 'B1' }] }, // packages to reverse
    );
    reverseStagedPackageMock.mockResolvedValueOnce({ attempted: true, success: false, error: 'SAP session lost' });

    const res = await request(app).delete('/1/packaging-holding');

    expect(res.status).toBe(422);
    expect(res.body.failures).toEqual([{ palletItemID: 10, sapMaterial: '30005R', sapBatch: 'B1', error: 'SAP session lost' }]);
  });

  test('cancels the picksheet once every package reverses cleanly', async () => {
    queueResults(
      { recordset: [{ pendingPackagingData: true }] },
      { recordset: [{ palletItemID: 10, sapMaterial: '30005R', sapBatch: 'B1' }] },
      { recordset: [] }, // the UPDATE
    );
    reverseStagedPackageMock.mockResolvedValueOnce({ attempted: true, success: true });

    const res = await request(app).delete('/1/packaging-holding');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});

describe('PATCH /:deliveryId/uncomplete', () => {
  test('404s when the delivery does not exist', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).patch('/999/uncomplete');
    expect(res.status).toBe(404);
  });

  test('409s when the delivery is not an active completed picksheet', async () => {
    queueResults({ recordset: [{ completionStatus: false, deliveryCancelled: false, pendingPackagingData: false, linkedShipmentDelivery: null }] });
    const res = await request(app).patch('/1/uncomplete');
    expect(res.status).toBe(409);
  });

  test('409s when already linked to a shipment', async () => {
    queueResults({ recordset: [{ completionStatus: true, deliveryCancelled: false, pendingPackagingData: false, linkedShipmentDelivery: 55 }] });
    const res = await request(app).patch('/1/uncomplete');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already linked to a shipment/);
  });

  test('reverses completion when eligible', async () => {
    queueResults(
      { recordset: [{ completionStatus: true, deliveryCancelled: false, pendingPackagingData: false, linkedShipmentDelivery: null }] },
      { recordset: [] }, // the UPDATE
    );
    const res = await request(app).patch('/1/uncomplete');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});
