// routes/palletvalidation.js manages Logistics.dbo.PalletValidation (the
// allowed pallet/packaging combinations) — no permission gates, no
// business logic beyond a straightforward join on GET /pallet/:palletId.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let palletValidationRouter;
let app;

beforeAll(async () => {
  ({ default: palletValidationRouter } = await import('../../routes/palletvalidation.js'));
  app = buildTestApp(palletValidationRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

test('GET / returns every record', async () => {
  queueResults({ recordset: [{ palletID: 'Euro', packagingID: 'DR' }] });
  const res = await request(app).get('/');
  expect(res.body).toEqual([{ palletID: 'Euro', packagingID: 'DR' }]);
});

test('GET /pallet/:palletId joins PackagingData detail onto each allowed packaging', async () => {
  queueResults({ recordset: [{ palletID: 'Euro', packagingID: 'DR', packMaterial: 'Steel' }] });
  const res = await request(app).get('/pallet/Euro');
  expect(res.body).toEqual({ success: true, data: [{ palletID: 'Euro', packagingID: 'DR', packMaterial: 'Steel' }] });
});

test('GET /packaging/:packagingId filters by packaging ID', async () => {
  queueResults({ recordset: [{ packagingID: 'DR' }] });
  const res = await request(app).get('/packaging/DR');
  expect(res.body).toEqual([{ packagingID: 'DR' }]);
});

test('POST / creates a record', async () => {
  queueResults({ recordset: [] });
  const res = await request(app).post('/').send({ palletID: 'Euro', packagingID: 'DR' });
  expect(res.status).toBe(201);
});

test('a DB failure on GET / is reported as a 500', async () => {
  dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
  const res = await request(app).get('/');
  expect(res.status).toBe(500);
});
