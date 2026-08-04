// routes/costelements.js manages Logistics.dbo.CostElements — the GL
// account codes both materialgroups.js and shipmentcost.js's costing logic
// key off. Straightforward CRUD; the one thing worth verifying beyond
// validation is PUT's @@ROWCOUNT-based 404 on an unknown elementId.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const logAdmin = { ...operatorUser, permissions: ['LOG_ADMIN'] };

let costElementsRouter;
let app;
let appAdmin;

beforeAll(async () => {
  ({ default: costElementsRouter } = await import('../../routes/costelements.js'));
  app = buildTestApp(costElementsRouter, { sessionUser: operatorUser });
  appAdmin = buildTestApp(costElementsRouter, { sessionUser: logAdmin });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET routes', () => {
  test('GET / returns every row', async () => {
    queueResults({ recordset: [{ elementID: 1 }] });
    const res = await request(app).get('/');
    expect(res.body).toEqual([{ elementID: 1 }]);
  });

  test('GET /id/:elementId filters by ID', async () => {
    queueResults({ recordset: [{ elementID: 1 }] });
    const res = await request(app).get('/id/1');
    expect(res.body).toEqual([{ elementID: 1 }]);
  });
});

describe('POST /', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).post('/').send({ elementCode: '602100', elementDescription: 'Freight' });
    expect(res.status).toBe(403);
  });

  test('400s without elementCode', async () => {
    const res = await request(appAdmin).post('/').send({ elementDescription: 'Freight' });
    expect(res.status).toBe(400);
  });

  test('400s without elementDescription', async () => {
    const res = await request(appAdmin).post('/').send({ elementCode: '602100' });
    expect(res.status).toBe(400);
  });

  test('creates a record', async () => {
    queueResults({ recordset: [{ elementID: 9 }] });
    const res = await request(appAdmin).post('/').send({ elementCode: '602100', elementDescription: 'Freight', direction: 'outbound', tier: 'standard' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ elementID: 9 });
  });
});

describe('PUT /:elementId', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).put('/1').send({ elementCode: '602100', elementDescription: 'Freight' });
    expect(res.status).toBe(403);
  });

  test('400s without elementDescription', async () => {
    const res = await request(appAdmin).put('/1').send({ elementCode: '602100' });
    expect(res.status).toBe(400);
  });

  test('404s when @@ROWCOUNT comes back zero', async () => {
    queueResults({ recordset: [{ rowsAffected: 0 }] });
    const res = await request(appAdmin).put('/999').send({ elementCode: '602100', elementDescription: 'Freight' });
    expect(res.status).toBe(404);
  });

  test('updates an existing record', async () => {
    queueResults({ recordset: [{ rowsAffected: 1 }] });
    const res = await request(appAdmin).put('/1').send({ elementCode: '602100', elementDescription: 'Freight' });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /:elementId', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).delete('/1');
    expect(res.status).toBe(403);
  });

  test('deletes a record', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAdmin).delete('/1');
    expect(res.body.success).toBe(true);
  });
});
