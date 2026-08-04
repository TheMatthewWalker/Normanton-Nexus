// routes/packagingdata.js is a CRUD surface over
// Logistics.dbo.PackagingData — only PUT (update) is permission-gated
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

let packagingDataRouter;
let app;
let appAdmin;

beforeAll(async () => {
  ({ default: packagingDataRouter } = await import('../../routes/packagingdata.js'));
  app = buildTestApp(packagingDataRouter, { sessionUser: operatorUser });
  appAdmin = buildTestApp(packagingDataRouter, { sessionUser: logAdmin });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

test('GET / returns every record', async () => {
  queueResults({ recordset: [{ packID: 'DR' }] });
  const res = await request(app).get('/');
  expect(res.body).toEqual([{ packID: 'DR' }]);
});

test('GET /id/:packId filters by pack ID', async () => {
  queueResults({ recordset: [{ packID: 'DR' }] });
  const res = await request(app).get('/id/DR');
  expect(res.body).toEqual([{ packID: 'DR' }]);
});

test('POST / creates a record', async () => {
  queueResults({ recordset: [] });
  const res = await request(app).post('/').send({ packID: 'DR', packMaterial: 'Steel', packWeight: 5 });
  expect(res.status).toBe(201);
});

describe('PUT /:packId', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).put('/DR').send({ packDescription: 'Drum' });
    expect(res.status).toBe(403);
  });

  test('updates a record', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAdmin).put('/DR').send({ packDescription: 'Drum' });
    expect(res.status).toBe(200);
  });
});

test('a DB failure on GET / is reported as a 500', async () => {
  dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
  const res = await request(app).get('/');
  expect(res.status).toBe(500);
});
