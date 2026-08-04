// routes/deliverylink.js is a minimal CRUD surface over
// Logistics.dbo.DeliveryLink — no permission gates, no business logic.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let deliveryLinkRouter;
let app;

beforeAll(async () => {
  ({ default: deliveryLinkRouter } = await import('../../routes/deliverylink.js'));
  app = buildTestApp(deliveryLinkRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

test('GET / returns every record', async () => {
  queueResults({ recordset: [{ deliveryID: 1, palletID: 1 }] });
  const res = await request(app).get('/');
  expect(res.body).toEqual([{ deliveryID: 1, palletID: 1 }]);
});

test('GET /delivery/:deliveryId filters by delivery', async () => {
  queueResults({ recordset: [{ deliveryID: 1 }] });
  const res = await request(app).get('/delivery/1');
  expect(res.body).toEqual([{ deliveryID: 1 }]);
});

test('GET /pallet/:palletId filters by pallet', async () => {
  queueResults({ recordset: [{ palletID: 1 }] });
  const res = await request(app).get('/pallet/1');
  expect(res.body).toEqual([{ palletID: 1 }]);
});

test('POST / creates a record', async () => {
  queueResults({ recordset: [] });
  const res = await request(app).post('/').send({ deliveryID: 1, palletID: 1 });
  expect(res.status).toBe(201);
});

test('a DB failure on GET / is reported as a 500', async () => {
  dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
  const res = await request(app).get('/');
  expect(res.status).toBe(500);
});
