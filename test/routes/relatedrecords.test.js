// routes/relatedrecords.js is the drill-down FK-lookup sibling of
// filterrecords.js — same allowlist/regex-validated-identifier security
// model, but always an exact match (no mode selection, always NVarChar).

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let relatedRecordsRouter;
let app;

beforeAll(async () => {
  ({ default: relatedRecordsRouter } = await import('../../routes/relatedrecords.js'));
  app = buildTestApp(relatedRecordsRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('input validation', () => {
  test.each(['tableName', 'fkCol'])('400s when %s is missing', async (field) => {
    const body = { tableName: 'Coils', fkCol: 'BatchID', fkValue: 'B1' };
    delete body[field];
    const res = await request(app).post('/').send(body);
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('400s when fkValue is null or undefined', async () => {
    const res = await request(app).post('/').send({ tableName: 'Coils', fkCol: 'BatchID', fkValue: null });
    expect(res.status).toBe(400);
  });

  test('accepts fkValue = 0 — falsy, but not "missing"', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).post('/').send({ tableName: 'Coils', fkCol: 'BatchID', fkValue: 0 });
    expect(res.status).toBe(200);
  });

  test('403s a table not on the allowlist', async () => {
    const res = await request(app).post('/').send({ tableName: 'PortalUsers', fkCol: 'UserID', fkValue: 1 });
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test.each([
    'BatchID; DROP TABLE dbo.Batches--',
    '1BatchID',
    'Batch ID',
  ])('400s an unsafe fkCol column name (%s)', async (fkCol) => {
    const res = await request(app).post('/').send({ tableName: 'Coils', fkCol, fkValue: 'B1' });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });
});

describe('execution', () => {
  test('builds an exact-match parameterized query against the allowlisted table/column', async () => {
    queueResults({ recordset: [{ CoilID: 1 }] });
    const res = await request(app).post('/').send({ tableName: 'Coils', fkCol: 'BatchID', fkValue: 'B1' });
    expect(res.body).toEqual({ success: true, recordset: [{ CoilID: 1 }] });
    expect(dbRequest.query.mock.calls[0][0]).toBe('SELECT TOP 500 * FROM dbo.Coils WHERE BatchID = @fkValue');
    expect(dbRequest.input).toHaveBeenCalledWith('fkValue', 'NVarChar(256)', 'B1');
  });

  test('a DB failure is reported as a 500', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
    const res = await request(app).post('/').send({ tableName: 'Coils', fkCol: 'BatchID', fkValue: 'B1' });
    expect(res.status).toBe(500);
  });
});
