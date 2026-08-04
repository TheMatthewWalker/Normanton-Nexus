// routes/forwarders.js manages Logistics.dbo.Forwarders, where a single
// vendor can have multiple rows (one per delivery mode) sharing the same
// forwarderID. The real logic worth testing is PUT /:forwarderId's
// originalMode pinning — it must scope the UPDATE to exactly the row being
// edited, not every sibling mode-row for that vendor — and its optimistic-
// concurrency 404 when @@ROWCOUNT comes back zero.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const logAdmin = { ...operatorUser, permissions: ['LOG_ADMIN'] };

let forwardersRouter;
let app;
let appAdmin;

beforeAll(async () => {
  ({ default: forwardersRouter } = await import('../../routes/forwarders.js'));
  app = buildTestApp(forwardersRouter, { sessionUser: operatorUser });
  appAdmin = buildTestApp(forwardersRouter, { sessionUser: logAdmin });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET routes', () => {
  test('GET / returns every row', async () => {
    queueResults({ recordset: [{ forwarderID: 1 }] });
    const res = await request(app).get('/');
    expect(res.body).toEqual([{ forwarderID: 1 }]);
  });

  test('GET /id/:forwarderId filters by ID', async () => {
    queueResults({ recordset: [{ forwarderID: 1 }] });
    const res = await request(app).get('/id/1');
    expect(res.body).toEqual([{ forwarderID: 1 }]);
  });

  test('GET /approved filters to forwarderApproval = 1', async () => {
    queueResults({ recordset: [{ forwarderID: 1, forwarderName: 'Acme Freight' }] });
    const res = await request(app).get('/approved');
    expect(res.body).toEqual([{ forwarderID: 1, forwarderName: 'Acme Freight' }]);
  });

  test('GET /modes returns distinct delivery modes', async () => {
    queueResults({ recordset: [{ forwarderMode: 'Road' }, { forwarderMode: 'Sea' }] });
    const res = await request(app).get('/modes');
    expect(res.body).toEqual([{ forwarderMode: 'Road' }, { forwarderMode: 'Sea' }]);
  });
});

describe('POST /', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).post('/').send({ forwarderID: 1, forwarderName: 'Acme' });
    expect(res.status).toBe(403);
  });

  test('400s without forwarderID or forwarderName', async () => {
    const res = await request(appAdmin).post('/').send({ forwarderID: 1 });
    expect(res.status).toBe(400);
  });

  test('creates a forwarder', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAdmin).post('/').send({ forwarderID: 1, forwarderName: 'Acme Freight', forwarderMode: 'Road' });
    expect(res.status).toBe(201);
  });
});

describe('PUT /:forwarderId', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).put('/1').send({ forwarderName: 'Acme' });
    expect(res.status).toBe(403);
  });

  test('400s when forwarderName is missing', async () => {
    const res = await request(appAdmin).put('/1').send({});
    expect(res.status).toBe(400);
  });

  test('scopes the UPDATE to the specific mode row via originalMode', async () => {
    queueResults({ recordset: [{ rowsAffected: 1 }] });
    const res = await request(appAdmin).put('/1').send({ forwarderName: 'Acme Freight', forwarderMode: 'Sea', originalMode: 'Road' });
    expect(res.status).toBe(200);
    expect(dbRequest.input).toHaveBeenCalledWith('originalMode', expect.anything(), 'Road');
  });

  test('404s (optimistic-concurrency) when no row matches forwarderId + originalMode', async () => {
    queueResults({ recordset: [{ rowsAffected: 0 }] });
    const res = await request(appAdmin).put('/1').send({ forwarderName: 'Acme Freight', originalMode: 'Air' });
    expect(res.status).toBe(404);
  });

  test('treats a missing originalMode as matching a NULL-mode row, not every row', async () => {
    queueResults({ recordset: [{ rowsAffected: 1 }] });
    const res = await request(appAdmin).put('/1').send({ forwarderName: 'Acme Freight' });
    expect(res.status).toBe(200);
    const sql = dbRequest.query.mock.calls[0][0];
    expect(sql).toContain('(forwarderMode = @originalMode OR (forwarderMode IS NULL AND @originalMode IS NULL))');
  });
});
