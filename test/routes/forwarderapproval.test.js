// routes/forwarderapproval.js is a minimal CRUD surface over
// Logistics.dbo.ForwarderApproval — no permission gates, no business logic
// beyond straight pass-through inserts/reads. Covering all three routes.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let forwarderApprovalRouter;
let app;

beforeAll(async () => {
  ({ default: forwarderApprovalRouter } = await import('../../routes/forwarderapproval.js'));
  app = buildTestApp(forwarderApprovalRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

test('GET / returns every record', async () => {
  queueResults({ recordset: [{ forwarderID: 1, ratesAgreed: true }] });
  const res = await request(app).get('/');
  expect(res.body).toEqual([{ forwarderID: 1, ratesAgreed: true }]);
});

test('GET /id/:forwarderId filters by ID', async () => {
  queueResults({ recordset: [{ forwarderID: 1 }] });
  const res = await request(app).get('/id/1');
  expect(res.body).toEqual([{ forwarderID: 1 }]);
});

test('POST / creates a record', async () => {
  queueResults({ recordset: [] });
  const res = await request(app).post('/').send({ forwarderID: 1, ratesAgreed: true, usageAgreed: false });
  expect(res.status).toBe(201);
});

test('a DB failure on GET / is reported as a 500', async () => {
  dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
  const res = await request(app).get('/');
  expect(res.status).toBe(500);
});
