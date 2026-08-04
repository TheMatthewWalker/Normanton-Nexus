// routes/incoterms.js is a minimal CRUD surface over
// Logistics.dbo.Incoterms — no permission gates, no business logic.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let incotermsRouter;
let app;

beforeAll(async () => {
  ({ default: incotermsRouter } = await import('../../routes/incoterms.js'));
  app = buildTestApp(incotermsRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

test('GET / returns every record', async () => {
  queueResults({ recordset: [{ incotermsID: 'DDP' }] });
  const res = await request(app).get('/');
  expect(res.body).toEqual([{ incotermsID: 'DDP' }]);
});

test('GET /id/:incotermsId filters by ID', async () => {
  queueResults({ recordset: [{ incotermsID: 'DDP' }] });
  const res = await request(app).get('/id/DDP');
  expect(res.body).toEqual([{ incotermsID: 'DDP' }]);
});

test('POST / creates a record', async () => {
  queueResults({ recordset: [] });
  const res = await request(app).post('/').send({ incotermsID: 'DDP', incotermsDescription: 'Delivered Duty Paid' });
  expect(res.status).toBe(201);
});

test('a DB failure on GET / is reported as a 500', async () => {
  dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
  const res = await request(app).get('/');
  expect(res.status).toBe(500);
});
