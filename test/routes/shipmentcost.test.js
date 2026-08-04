// routes/shipmentcost.js (883 lines) — representative sample of the plain
// CRUD + validation endpoints. The SAP-posting-heavy endpoints
// (/estimate, /unprocessed, /post-migo, /:costId/reverse) aren't covered
// here yet — they pull in lib/sapCredentials.js + routes/materialgroups.js
// + a live-posting axios flow and are a natural next slice — see CLAUDE.md.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const reportsUser = { ...operatorUser, permissions: ['LOG_REPORTS'] };

let costRouter;
let app;
let appReports;

beforeAll(async () => {
  ({ default: costRouter } = await import('../../routes/shipmentcost.js'));
  app = buildTestApp(costRouter, { sessionUser: operatorUser });
  appReports = buildTestApp(costRouter, { sessionUser: reportsUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET /', () => {
  test('returns the raw recordset', async () => {
    queueResults({ recordset: [{ costID: 1 }] });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ costID: 1 }]);
  });
});

describe('PATCH /:costId', () => {
  test('rejects a non-positive expectedCost', async () => {
    const res = await request(app).patch('/1').send({ expectedCost: -5 });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('400s when the line does not exist or is already posted to SAP', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).patch('/1').send({ expectedCost: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already posted/);
  });

  test('updates the amount when the line is editable', async () => {
    queueResults({ recordset: [{ costID: 1 }] });
    const res = await request(app).patch('/1').send({ expectedCost: 100 });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /:costId', () => {
  test('400s when the line does not exist or is already posted', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).delete('/1');
    expect(res.status).toBe(400);
  });

  test('deletes an editable line', async () => {
    queueResults({ recordset: [{ costID: 1 }] });
    const res = await request(app).delete('/1');
    expect(res.status).toBe(200);
  });
});

describe('GET /shipment/:shipmentId', () => {
  test('returns the wrapped {success, data} shape', async () => {
    queueResults({ recordset: [{ costID: 1, shipmentID: 55 }] });
    const res = await request(app).get('/shipment/55');
    expect(res.body).toEqual({ success: true, data: [{ costID: 1, shipmentID: 55 }] });
  });
});

describe('POST / (create)', () => {
  test('requires either shipmentID or poShipmentID', async () => {
    const res = await request(app).post('/').send({ costElement: 'X', costCenter: 'Y', expectedCost: 10 });
    expect(res.status).toBe(400);
  });

  test('requires costElement', async () => {
    const res = await request(app).post('/').send({ shipmentID: 1, costCenter: 'Y', expectedCost: 10 });
    expect(res.status).toBe(400);
  });

  test('requires costCenter', async () => {
    const res = await request(app).post('/').send({ shipmentID: 1, costElement: 'X', expectedCost: 10 });
    expect(res.status).toBe(400);
  });

  test('requires a positive expectedCost', async () => {
    const res = await request(app).post('/').send({ shipmentID: 1, costElement: 'X', costCenter: 'Y', expectedCost: 0 });
    expect(res.status).toBe(400);
  });

  test('creates a cost line and returns the new costID', async () => {
    queueResults({ recordset: [{ costID: 42 }] });
    const res = await request(app).post('/').send({ shipmentID: 1, costElement: 'X', costCenter: 'Y', expectedCost: 100 });
    expect(res.status).toBe(201);
    expect(res.body.costID).toBe(42);
  });
});

describe('GET /analytics', () => {
  test('is rejected for a user without LOG_ADMIN/LOG_MRP/LOG_REPORTS', async () => {
    const res = await request(app).get('/analytics');
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });
});
