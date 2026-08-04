// routes/palletdata.js is a CRUD surface over Logistics.dbo.PalletData —
// same shape as packagingdata.js: only PUT (update) is permission-gated
// (LOG_ADMIN); GET/POST are open to any session.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const logAdmin = { ...operatorUser, permissions: ['LOG_ADMIN'] };

let palletDataRouter;
let app;
let appAdmin;

beforeAll(async () => {
  ({ default: palletDataRouter } = await import('../../routes/palletdata.js'));
  app = buildTestApp(palletDataRouter, { sessionUser: operatorUser });
  appAdmin = buildTestApp(palletDataRouter, { sessionUser: logAdmin });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

test('GET / returns every record', async () => {
  queueResults({ recordset: [{ palletID: 'Euro' }] });
  const res = await request(app).get('/');
  expect(res.body).toEqual([{ palletID: 'Euro' }]);
});

test('GET /id/:palletId filters by pallet ID', async () => {
  queueResults({ recordset: [{ palletID: 'Euro' }] });
  const res = await request(app).get('/id/Euro');
  expect(res.body).toEqual([{ palletID: 'Euro' }]);
});

test('POST / creates a record', async () => {
  queueResults({ recordset: [] });
  const res = await request(app).post('/').send({ palletID: 'Euro', palletDescription: 'Euro pallet', palletWeight: 25 });
  expect(res.status).toBe(201);
});

describe('PUT /:palletId', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).put('/Euro').send({ palletDescription: 'Updated' });
    expect(res.status).toBe(403);
  });

  test('updates a record', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAdmin).put('/Euro').send({ palletDescription: 'Updated' });
    expect(res.status).toBe(200);
  });
});

test('a DB failure on GET / is reported as a 500', async () => {
  dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
  const res = await request(app).get('/');
  expect(res.status).toBe(500);
});
