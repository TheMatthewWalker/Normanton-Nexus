// routes/costcenters.js manages Logistics.dbo.CostCenters — same shape as
// costelements.js (covered separately): straightforward CRUD, with PUT's
// @@ROWCOUNT-based 404 the only thing worth verifying beyond validation.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const logAdmin = { ...operatorUser, permissions: ['LOG_ADMIN'] };

let costCentersRouter;
let app;
let appAdmin;

beforeAll(async () => {
  ({ default: costCentersRouter } = await import('../../routes/costcenters.js'));
  app = buildTestApp(costCentersRouter, { sessionUser: operatorUser });
  appAdmin = buildTestApp(costCentersRouter, { sessionUser: logAdmin });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET routes', () => {
  test('GET / returns every row', async () => {
    queueResults({ recordset: [{ centerID: 1 }] });
    const res = await request(app).get('/');
    expect(res.body).toEqual([{ centerID: 1 }]);
  });

  test('GET /id/:centerId filters by ID', async () => {
    queueResults({ recordset: [{ centerID: 1 }] });
    const res = await request(app).get('/id/1');
    expect(res.body).toEqual([{ centerID: 1 }]);
  });
});

describe('POST /', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).post('/').send({ centerCode: '2012', centerDescription: 'Inbound' });
    expect(res.status).toBe(403);
  });

  test('400s without centerCode', async () => {
    const res = await request(appAdmin).post('/').send({ centerDescription: 'Inbound' });
    expect(res.status).toBe(400);
  });

  test('400s without centerDescription', async () => {
    const res = await request(appAdmin).post('/').send({ centerCode: '2012' });
    expect(res.status).toBe(400);
  });

  test('creates a record', async () => {
    queueResults({ recordset: [{ centerID: 9 }] });
    const res = await request(appAdmin).post('/').send({ centerCode: '2012', centerDescription: 'Inbound' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ centerID: 9 });
  });
});

describe('PUT /:centerId', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).put('/1').send({ centerCode: '2012', centerDescription: 'Inbound' });
    expect(res.status).toBe(403);
  });

  test('400s without centerDescription', async () => {
    const res = await request(appAdmin).put('/1').send({ centerCode: '2012' });
    expect(res.status).toBe(400);
  });

  test('404s when @@ROWCOUNT comes back zero', async () => {
    queueResults({ recordset: [{ rowsAffected: 0 }] });
    const res = await request(appAdmin).put('/999').send({ centerCode: '2012', centerDescription: 'Inbound' });
    expect(res.status).toBe(404);
  });

  test('updates an existing record', async () => {
    queueResults({ recordset: [{ rowsAffected: 1 }] });
    const res = await request(appAdmin).put('/1').send({ centerCode: '2012', centerDescription: 'Inbound' });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /:centerId', () => {
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
