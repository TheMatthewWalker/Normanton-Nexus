// routes/production.js is ~30 near-identical parameterized read endpoints
// (Batches/Mixing/Extrusion/Convo/Ewald/Firewall/Staging, each with a
// top-500 list + filtered-by-ID variants) with no business logic beyond the
// query itself — one representative endpoint per table family is enough to
// confirm the pattern holds; testing all 30 would just repeat the same
// assertion with a different table name.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let productionRouter;
let app;

beforeAll(async () => {
  ({ default: productionRouter } = await import('../../routes/production.js'));
  app = buildTestApp(productionRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

test('GET /batches returns the raw recordset', async () => {
  queueResults({ recordset: [{ Batch: 'B1' }] });
  const res = await request(app).get('/batches');
  expect(res.status).toBe(200);
  expect(res.body).toEqual([{ Batch: 'B1' }]);
});

test('GET /batches/batch/:batch filters by batch', async () => {
  queueResults({ recordset: [{ Batch: 'B1', Material: '30005R' }] });
  const res = await request(app).get('/batches/batch/B1');
  expect(res.body).toEqual([{ Batch: 'B1', Material: '30005R' }]);
});

test('GET /mixing/:mixingId/matdocs (nested child route)', async () => {
  queueResults({ recordset: [{ MixingBatch: 'MX1' }] });
  const res = await request(app).get('/mixing/MX1/matdocs');
  expect(res.status).toBe(200);
});

test('GET /extrusion/:extBatch/trace', async () => {
  queueResults({ recordset: [] });
  const res = await request(app).get('/extrusion/EX1/trace');
  expect(res.status).toBe(200);
});

test('GET /convo/:convoId/waste', async () => {
  queueResults({ recordset: [] });
  const res = await request(app).get('/convo/CO1/waste');
  expect(res.status).toBe(200);
});

test('GET /ewald/:ewaldId/scrapdocs', async () => {
  queueResults({ recordset: [] });
  const res = await request(app).get('/ewald/1/scrapdocs');
  expect(res.status).toBe(200);
});

test('GET /firewall/:sapBatch/messages', async () => {
  queueResults({ recordset: [] });
  const res = await request(app).get('/firewall/FW1/messages');
  expect(res.status).toBe(200);
});

test('GET /staging/:stagingId/items', async () => {
  queueResults({ recordset: [] });
  const res = await request(app).get('/staging/1/items');
  expect(res.status).toBe(200);
});

test('a query failure is reported as a 500 with the error message', async () => {
  dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
  const res = await request(app).get('/batches');
  expect(res.status).toBe(500);
  expect(res.body.error).toBe('connection lost');
});
