// routes/sqlqueries.js exposes a raw-SQL console (POST /query, gated by
// requireLogin + a forbidden-keyword block for non-admins) and a CSV export
// endpoint (POST /query-csv, gated by a shared API key for Excel/external-
// tool access — no session required).
//
// POST /query-csv previously threw `ReferenceError: config is not defined`
// on every request (it read `config.apiKey`, but only `auditQuery`/
// `sqlConfig` were ever imported from ../config.js) — fixed by adding a
// proper `apiKey` named export to config.js and importing it here. The
// correct key value is read from config.js itself (real or the test
// fixture — see test/jest.globalSetup.js) rather than assumed, so this
// suite works the same whether config.json is the throwaway test fixture
// or a real developer config.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser, adminUser, superadminUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let sqlqueriesRouter;
let apiKey;
let app;
let appAdmin;
let appSuperadmin;
let appNoSession;

beforeAll(async () => {
  ({ default: sqlqueriesRouter } = await import('../../routes/sqlqueries.js'));
  ({ apiKey } = await import('../../config.js'));
  app = buildTestApp(sqlqueriesRouter, { sessionUser: operatorUser });
  appAdmin = buildTestApp(sqlqueriesRouter, { sessionUser: adminUser });
  appSuperadmin = buildTestApp(sqlqueriesRouter, { sessionUser: superadminUser });
  appNoSession = buildTestApp(sqlqueriesRouter);
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  // config.js's real auditQuery() is exercised (not mocked) — it makes its
  // own pool.request().query(INSERT ...) call against this same shared mock,
  // so a passing default keeps it a fire-and-forget no-op here.
  dbRequest.query.mockResolvedValue({ recordset: [], rowsAffected: [0] });
});

// auditQuery() and the route's own query share the same mocked
// pool.request(), so every .input('eventType', ..., value) call — from
// either the command itself or its audit-log insert — lands in this one
// shared history. Filtering it is the only way to see which audit events a
// request actually fired, since auditQuery is real code here, not a mock.
function auditedEventTypes() {
  return dbRequest.input.mock.calls
    .filter(call => call[0] === 'eventType')
    .map(call => call[2]);
}

describe('POST /query', () => {
  test('rejects (401 JSON or redirect) when not logged in', async () => {
    const res = await request(appNoSession).post('/query').send({ query: 'SELECT 1' });
    expect([302, 401]).toContain(res.status);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('400s when the query is missing', async () => {
    const res = await request(app).post('/query').send({});
    expect(res.status).toBe(400);
  });

  test.each(['DELETE', 'DROP', 'UPDATE', 'INSERT', 'ALTER', 'TRUNCATE', 'EXEC', 'MERGE'])(
    'blocks a non-admin query containing the forbidden keyword %s',
    async (keyword) => {
      const res = await request(app).post('/query').send({ query: `${keyword} FROM dbo.Foo` });
      expect(res.status).toBe(403);
      // Only the audit-log insert should have run — never the query itself.
      expect(dbRequest.query).toHaveBeenCalledTimes(1);
      expect(auditedEventTypes()).toEqual(['RAW_SQL_BLOCKED']);
    },
  );

  test('allows a non-admin plain SELECT through', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ x: 1 }], rowsAffected: [1] });
    const res = await request(app).post('/query').send({ query: 'SELECT 1 AS x' });
    expect(res.status).toBe(200);
    expect(res.body.recordset).toEqual([{ x: 1 }]);
    expect(auditedEventTypes()).toEqual(['RAW_SQL']);
  });

  test('returns every SELECT in a multi-statement batch as recordsets, in order', async () => {
    // mssql's own Request.query() returns one entry per result-returning
    // statement in `recordsets` (with `recordset` as an alias for the
    // first) — the mock reproduces that shape directly rather than going
    // through the mock's query-queueing helper, since this is one call, not several.
    dbRequest.query.mockResolvedValueOnce({
      recordset: [{ a: 1 }],
      recordsets: [[{ a: 1 }], [{ b: 2 }, { b: 3 }]],
      rowsAffected: [1, 2],
    });
    const res = await request(app).post('/query').send({ query: 'SELECT 1 AS a; SELECT 2 AS b UNION ALL SELECT 3' });
    expect(res.status).toBe(200);
    expect(res.body.recordsets).toEqual([[{ a: 1 }], [{ b: 2 }, { b: 3 }]]);
    expect(res.body.recordset).toEqual([{ a: 1 }]); // back-compat: still just the first
  });

  test('an admin bypasses the forbidden-keyword block', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [], rowsAffected: [3] });
    const res = await request(appAdmin).post('/query').send({ query: 'DELETE FROM dbo.Foo' });
    expect(res.status).toBe(200);
    expect(dbRequest.query).toHaveBeenCalledTimes(2); // the DELETE, then the audit insert
  });

  test('a superadmin bypasses the forbidden-keyword block', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [], rowsAffected: [1] });
    const res = await request(appSuperadmin).post('/query').send({ query: 'TRUNCATE TABLE dbo.Foo' });
    expect(res.status).toBe(200);
  });

  test('a DB failure is reported as a 500 and audited as RAW_SQL_ERROR', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
    const res = await request(app).post('/query').send({ query: 'SELECT 1' });
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(auditedEventTypes()).toEqual(['RAW_SQL_ERROR']);
  });
});

describe('POST /query-csv', () => {
  test('403s a wrong or missing key without ever reaching the DB', async () => {
    const wrongKey = await request(appNoSession).post('/query-csv').send({ query: 'SELECT 1', key: 'not-the-real-key' });
    expect(wrongKey.status).toBe(403);

    const missingKey = await request(appNoSession).post('/query-csv').send({ query: 'SELECT 1' });
    expect(missingKey.status).toBe(403);

    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('400s when the query is missing, even with a correct key', async () => {
    const res = await request(appNoSession).post('/query-csv').send({ key: apiKey });
    expect(res.status).toBe(400);
  });

  test('streams a semicolon-delimited CSV with an attachment header on success', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ Batch: 'B1', Material: '30005R' }, { Batch: 'B2', Material: '30006R' }] });
    const res = await request(appNoSession).post('/query-csv').send({ key: apiKey, query: 'SELECT Batch, Material FROM dbo.Batches' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain('attachment; filename=results.csv');
    expect(res.text).toBe('Batch;Material\r\n"B1";"30005R"\r\n"B2";"30006R"');
  });

  test('reports success with no data when the query returns an empty recordset', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });
    const res = await request(appNoSession).post('/query-csv').send({ key: apiKey, query: 'SELECT * FROM dbo.Batches WHERE 1=0' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Query executed successfully (no data returned)' });
  });

  test('reports the rows-affected count for a non-SELECT statement (no recordset)', async () => {
    dbRequest.query.mockResolvedValueOnce({ rowsAffected: [3] });
    const res = await request(appNoSession).post('/query-csv').send({ key: apiKey, query: 'UPDATE dbo.Batches SET x = 1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, rowsAffected: 3, message: '3 row(s) affected' });
  });

  test('a DB failure is reported as a 500', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
    const res = await request(appNoSession).post('/query-csv').send({ key: apiKey, query: 'SELECT 1' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, message: 'connection lost' });
  });
});
