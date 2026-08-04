// routes/ratestpn.js is a minimal CRUD surface over
// Logistics.dbo.RatesTPN — no permission gates, no business logic beyond
// straight pass-through inserts/reads (unlike rateskn.js, there's no
// pricing /lookup route here).

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let ratesTpnRouter;
let app;

beforeAll(async () => {
  ({ default: ratesTpnRouter } = await import('../../routes/ratestpn.js'));
  app = buildTestApp(ratesTpnRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

test('GET / returns every record', async () => {
  queueResults({ recordset: [{ postalZone: 'Z1' }] });
  const res = await request(app).get('/');
  expect(res.body).toEqual([{ postalZone: 'Z1' }]);
});

test('GET /zone/:postalZone filters by zone', async () => {
  queueResults({ recordset: [{ postalZone: 'Z1' }] });
  const res = await request(app).get('/zone/Z1');
  expect(res.body).toEqual([{ postalZone: 'Z1' }]);
});

test('GET /category/:palletCategory filters by category', async () => {
  queueResults({ recordset: [{ palletCategory: 'Euro' }] });
  const res = await request(app).get('/category/Euro');
  expect(res.body).toEqual([{ palletCategory: 'Euro' }]);
});

test('POST / creates a record', async () => {
  queueResults({ recordset: [] });
  const res = await request(app).post('/').send({ postalZone: 'Z1', palletCategory: 'Euro', serviceLevel: 'Standard', agreedRate: 25 });
  expect(res.status).toBe(201);
});

test('a DB failure on GET / is reported as a 500', async () => {
  dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
  const res = await request(app).get('/');
  expect(res.status).toBe(500);
});
