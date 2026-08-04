// routes/shipmentlink.js is a minimal CRUD surface over
// Logistics.dbo.ShipmentLink — no permission gates, no business logic.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let shipmentLinkRouter;
let app;

beforeAll(async () => {
  ({ default: shipmentLinkRouter } = await import('../../routes/shipmentlink.js'));
  app = buildTestApp(shipmentLinkRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

test('GET / returns every record', async () => {
  queueResults({ recordset: [{ shipmentID: 1, deliveryID: 1 }] });
  const res = await request(app).get('/');
  expect(res.body).toEqual([{ shipmentID: 1, deliveryID: 1 }]);
});

test('GET /shipment/:shipmentId filters by shipment', async () => {
  queueResults({ recordset: [{ shipmentID: 1 }] });
  const res = await request(app).get('/shipment/1');
  expect(res.body).toEqual([{ shipmentID: 1 }]);
});

test('GET /delivery/:deliveryId filters by delivery', async () => {
  queueResults({ recordset: [{ deliveryID: 1 }] });
  const res = await request(app).get('/delivery/1');
  expect(res.body).toEqual([{ deliveryID: 1 }]);
});

test('POST / creates a record', async () => {
  queueResults({ recordset: [] });
  const res = await request(app).post('/').send({ shipmentID: 1, deliveryID: 1 });
  expect(res.status).toBe(201);
});

test('a DB failure on GET / is reported as a 500', async () => {
  dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
  const res = await request(app).get('/');
  expect(res.status).toBe(500);
});
