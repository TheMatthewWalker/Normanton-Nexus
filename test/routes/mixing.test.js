// routes/mixing.js is mostly simple parameterized reads, but POST /search
// builds a dynamic WHERE clause (AND within a row, OR between rows, plus a
// date-range vs. exact-date branch) — the one piece of real logic in this
// file, and worth verifying against the actual generated SQL text rather
// than just the HTTP response.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let mixingRouter;
let app;

beforeAll(async () => {
  ({ default: mixingRouter } = await import('../../routes/mixing.js'));
  app = buildTestApp(mixingRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  dbRequest.query.mockResolvedValue({ recordset: [] });
});

test('GET / returns the raw recordset', async () => {
  dbRequest.query.mockResolvedValueOnce({ recordset: [{ MixingID: 1 }] });
  const res = await request(app).get('/');
  expect(res.body).toEqual([{ MixingID: 1 }]);
});

test('GET /id/:mixingId filters by MixingID', async () => {
  const res = await request(app).get('/id/MX1');
  expect(res.status).toBe(200);
});

describe('POST /search — dynamic WHERE clause builder', () => {
  test('an empty rows array returns everything, unfiltered', async () => {
    const res = await request(app).post('/search').send([]);
    expect(res.status).toBe(200);
    expect(dbRequest.query.mock.calls[0][0]).toBe('SELECT * FROM dbo.Mixing');
  });

  test('a single row ANDs its filled-in fields together', async () => {
    await request(app).post('/search').send([{ mixCode: 'ABC', operator: 'j.smith' }]);
    const sql = dbRequest.query.mock.calls[0][0];
    expect(sql).toContain('WHERE (MixCode = @mixCode_0 AND Operator = @operator_0)');
  });

  test('multiple rows are ORed together', async () => {
    await request(app).post('/search').send([{ mixCode: 'ABC' }, { operator: 'j.smith' }]);
    const sql = dbRequest.query.mock.calls[0][0];
    expect(sql).toContain('WHERE (MixCode = @mixCode_0) OR (Operator = @operator_1)');
  });

  test('a row with both creationDate and dateTo becomes a BETWEEN range', async () => {
    await request(app).post('/search').send([{ creationDate: '01.01.26', dateTo: '31.01.26' }]);
    const sql = dbRequest.query.mock.calls[0][0];
    expect(sql).toContain('CONVERT(datetime, CreationDate, 104) BETWEEN CONVERT(datetime, @dateFrom_0, 104) AND CONVERT(datetime, @dateTo_0, 104)');
  });

  test('a row with only creationDate becomes an exact-date equality', async () => {
    await request(app).post('/search').send([{ creationDate: '01.01.26' }]);
    const sql = dbRequest.query.mock.calls[0][0];
    expect(sql).toContain('CreationDate = @dateFrom_0');
    expect(sql).not.toContain('BETWEEN');
  });

  test('a row with no recognised fields at all is dropped, not turned into an empty AND group', async () => {
    await request(app).post('/search').send([{ mixCode: 'ABC' }, {}]);
    const sql = dbRequest.query.mock.calls[0][0];
    expect(sql).toBe('SELECT * FROM dbo.Mixing WHERE (MixCode = @mixCode_0) ORDER BY MixingID DESC');
  });
});

describe('POST / (create) and PUT /:mixingId (update)', () => {
  test('creates a record', async () => {
    const res = await request(app).post('/').send({ MixingID: 'MX1', MixCode: 'ABC' });
    expect(res.status).toBe(201);
  });

  test('updates a record', async () => {
    const res = await request(app).put('/MX1').send({ MixCode: 'DEF' });
    expect(res.status).toBe(200);
  });
});
