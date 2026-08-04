// routes/palletpackages.js manages Logistics.dbo.PalletPackages. Real logic
// worth testing: PATCH /:id's "at least one of layer/packagingID" +
// per-field validation and dynamic SET clause, and DELETE /:id's
// reverse-staged-package-before-delete guard (same pattern as
// palletmain.js's PATCH /:palletId, tested there).

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const reverseStagedPackageMock = jest.fn();
jest.unstable_mockModule('../../routes/sapStaging.js', () => ({
  reverseStagedPackage: reverseStagedPackageMock,
}));

let palletPackagesRouter;
let app;

beforeAll(async () => {
  ({ default: palletPackagesRouter } = await import('../../routes/palletpackages.js'));
  app = buildTestApp(palletPackagesRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  reverseStagedPackageMock.mockReset();
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET routes', () => {
  test('GET / returns the raw recordset', async () => {
    queueResults({ recordset: [{ palletItemID: 1 }] });
    const res = await request(app).get('/');
    expect(res.body).toEqual([{ palletItemID: 1 }]);
  });

  test('GET /pallet/:palletId joins PackagingData descriptions', async () => {
    queueResults({ recordset: [{ palletItemID: 1, packDescription: 'Drum' }] });
    const res = await request(app).get('/pallet/1');
    expect(res.body).toEqual({ success: true, data: [{ palletItemID: 1, packDescription: 'Drum' }] });
  });
});

describe('POST /', () => {
  test('creates a package and returns the identity value', async () => {
    queueResults({ recordset: [{ palletItemID: 42 }] });
    const res = await request(app).post('/').send({ palletID: 1, sapMaterial: '30005R' });
    expect(res.status).toBe(201);
    expect(res.body.palletItemID).toBe(42);
  });
});

describe('PATCH /:palletItemId', () => {
  test('400s when neither palletLayer nor packagingID is provided', async () => {
    const res = await request(app).patch('/1').send({});
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('400s on a non-positive palletLayer', async () => {
    const res = await request(app).patch('/1').send({ palletLayer: 0 });
    expect(res.status).toBe(400);
  });

  test('400s on a blank packagingID', async () => {
    const res = await request(app).patch('/1').send({ packagingID: '   ' });
    expect(res.status).toBe(400);
  });

  test('only sets the fields actually provided', async () => {
    queueResults({ rowsAffected: [1] });
    await request(app).patch('/1').send({ packagingID: 'DR' });
    const sql = dbRequest.query.mock.calls[0][0];
    expect(sql).toContain('packagingID = @packagingID');
    expect(sql).not.toContain('palletLayer');
  });

  test('sets both fields when both are provided', async () => {
    queueResults({ rowsAffected: [1] });
    await request(app).patch('/1').send({ palletLayer: 2, packagingID: 'DR' });
    const sql = dbRequest.query.mock.calls[0][0];
    expect(sql).toContain('palletLayer = @palletLayer, packagingID = @packagingID');
  });

  test('404s when the package does not exist', async () => {
    queueResults({ rowsAffected: [0] });
    const res = await request(app).patch('/999').send({ palletLayer: 2 });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /:palletItemId', () => {
  test('deletes straight away when the package was never staged in SAP', async () => {
    queueResults(
      { recordset: [{ sapMaterial: null, sapBatch: null, sapDelivery: null }] },
      { recordset: [] }, // the DELETE
    );
    reverseStagedPackageMock.mockResolvedValueOnce({ attempted: false });
    const res = await request(app).delete('/1');
    expect(res.status).toBe(200);
    expect(dbRequest.query).toHaveBeenCalledTimes(2);
  });

  test('blocks the delete when the SAP reversal fails', async () => {
    queueResults({ recordset: [{ sapMaterial: '30005R', sapBatch: 'B1', sapDelivery: 'D1' }] });
    reverseStagedPackageMock.mockResolvedValueOnce({ attempted: true, success: false, error: 'SAP session lost' });
    const res = await request(app).delete('/1');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/SAP session lost — package was not removed/);
    expect(dbRequest.query).toHaveBeenCalledTimes(1); // only the lookup, no DELETE
  });

  test('deletes once the SAP reversal succeeds', async () => {
    queueResults(
      { recordset: [{ sapMaterial: '30005R', sapBatch: 'B1', sapDelivery: 'D1' }] },
      { recordset: [] }, // the DELETE
    );
    reverseStagedPackageMock.mockResolvedValueOnce({ attempted: true, success: true });
    const res = await request(app).delete('/1');
    expect(res.status).toBe(200);
    expect(dbRequest.query).toHaveBeenCalledTimes(2);
  });
});
