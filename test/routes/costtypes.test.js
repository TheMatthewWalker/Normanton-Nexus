// routes/costtypes.js is a minimal CRUD surface over
// Logistics.dbo.CostTypes — no permission gates, no business logic.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let costTypesRouter;
let app;

beforeAll(async () => {
  ({ default: costTypesRouter } = await import('../../routes/costtypes.js'));
  app = buildTestApp(costTypesRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

test('GET / returns every record', async () => {
  queueResults({ recordset: [{ typeID: 1, typeDescription: 'General Freight' }] });
  const res = await request(app).get('/');
  expect(res.body).toEqual([{ typeID: 1, typeDescription: 'General Freight' }]);
});

test('GET /id/:typeId filters by ID', async () => {
  queueResults({ recordset: [{ typeID: 1 }] });
  const res = await request(app).get('/id/1');
  expect(res.body).toEqual([{ typeID: 1 }]);
});

test('POST / creates a record', async () => {
  queueResults({ recordset: [] });
  const res = await request(app).post('/').send({ typeID: 1, typeDescription: 'General Freight' });
  expect(res.status).toBe(201);
});

// typeID is a SAP-issued code, not always numeric (e.g. 'ITLG06A' for
// Warehousing) — binding it as sql.BigInt would throw a conversion error
// for these before it ever reached the (mocked) query call.
test('POST / accepts an alphanumeric typeID', async () => {
  queueResults({ recordset: [] });
  const res = await request(app).post('/').send({ typeID: 'ITLG06A', typeDescription: 'Warehousing' });
  expect(res.status).toBe(201);
  expect(dbRequest.input).toHaveBeenCalledWith('typeID', 'NVarChar(10)', 'ITLG06A');
});

test('a DB failure on GET / is reported as a 500', async () => {
  dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
  const res = await request(app).get('/');
  expect(res.status).toBe(500);
});
