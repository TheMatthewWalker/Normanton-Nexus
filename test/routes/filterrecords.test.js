// routes/filterrecords.js is a parameterized ad-hoc filter endpoint for the
// table browser — security hinges on its table allowlist, the column-name
// regex (identifiers only, no injection surface), and the mode whitelist,
// since tableName/col are interpolated straight into the query text (only
// the value itself is ever bound as a parameter). Also covers the
// exact/BigInt vs LIKE/NVarChar type-selection logic and the val=0 edge
// case (falsy but not "missing").

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let filterRecordsRouter;
let app;

beforeAll(async () => {
  ({ default: filterRecordsRouter } = await import('../../routes/filterrecords.js'));
  app = buildTestApp(filterRecordsRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('input validation', () => {
  test.each(['tableName', 'col', 'mode'])('400s when %s is missing', async (field) => {
    const body = { tableName: 'Batches', col: 'Batch', mode: 'contains', val: 'x' };
    delete body[field];
    const res = await request(app).post('/').send(body);
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('400s when val is null or undefined', async () => {
    const res = await request(app).post('/').send({ tableName: 'Batches', col: 'Batch', mode: 'contains', val: null });
    expect(res.status).toBe(400);
  });

  test('accepts val = 0 — falsy, but not "missing"', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).post('/').send({ tableName: 'Batches', col: 'Batch', mode: 'exact', val: 0 });
    expect(res.status).toBe(200);
  });

  test('accepts val = "" (empty string) — not null/undefined', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).post('/').send({ tableName: 'Batches', col: 'Batch', mode: 'contains', val: '' });
    expect(res.status).toBe(200);
  });

  test('403s a table not on the allowlist', async () => {
    const res = await request(app).post('/').send({ tableName: 'PortalUsers', col: 'Username', mode: 'contains', val: 'x' });
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test.each([
    'Batch; DROP TABLE dbo.Batches--',
    '1Batch',
    'Batch Name',
    "Batch'--",
  ])('400s an unsafe column name (%s)', async (col) => {
    const res = await request(app).post('/').send({ tableName: 'Batches', col, mode: 'contains', val: 'x' });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('accepts a valid identifier-shaped column name', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).post('/').send({ tableName: 'Batches', col: 'Batch_Number', mode: 'contains', val: 'x' });
    expect(res.status).toBe(200);
  });

  test('400s an invalid filter mode', async () => {
    const res = await request(app).post('/').send({ tableName: 'Batches', col: 'Batch', mode: 'regex', val: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('LIKE pattern / type selection by mode', () => {
  test('"contains" wraps the value in % wildcards and binds as NVarChar', async () => {
    queueResults({ recordset: [] });
    await request(app).post('/').send({ tableName: 'Batches', col: 'Batch', mode: 'contains', val: 'ABC' });
    expect(dbRequest.query.mock.calls[0][0]).toContain('WHERE Batch LIKE @val');
    expect(dbRequest.input).toHaveBeenCalledWith('val', expect.anything(), '%ABC%');
  });

  test('"starts" appends a trailing % only', async () => {
    queueResults({ recordset: [] });
    await request(app).post('/').send({ tableName: 'Batches', col: 'Batch', mode: 'starts', val: 'ABC' });
    expect(dbRequest.input).toHaveBeenCalledWith('val', expect.anything(), 'ABC%');
  });

  test('"exact" with a non-integer value uses = with a plain NVarChar bind', async () => {
    queueResults({ recordset: [] });
    await request(app).post('/').send({ tableName: 'Batches', col: 'Batch', mode: 'exact', val: 'ABC123' });
    expect(dbRequest.query.mock.calls[0][0]).toContain('WHERE Batch = @val');
    expect(dbRequest.input).toHaveBeenCalledWith('val', 'NVarChar(500)', 'ABC123');
  });

  test('"exact" with an integer-shaped value binds as BigInt with the numeric value, not the string', async () => {
    queueResults({ recordset: [] });
    await request(app).post('/').send({ tableName: 'Batches', col: 'BatchID', mode: 'exact', val: '12345' });
    expect(dbRequest.input.mock.calls[0][1]).not.toBe('NVarChar(500)'); // BigInt is a bare mock fn, not the NVarChar(500) string
    expect(dbRequest.input).toHaveBeenCalledWith('val', expect.anything(), 12345);
  });

  test('"contains"/"starts" never use BigInt, even for a numeric-looking value', async () => {
    queueResults({ recordset: [] });
    await request(app).post('/').send({ tableName: 'Batches', col: 'BatchID', mode: 'contains', val: '12345' });
    expect(dbRequest.input).toHaveBeenCalledWith('val', 'NVarChar(500)', '%12345%');
  });
});

describe('execution', () => {
  test('returns the recordset on success', async () => {
    queueResults({ recordset: [{ Batch: 'B1' }] });
    const res = await request(app).post('/').send({ tableName: 'Batches', col: 'Batch', mode: 'contains', val: 'B' });
    expect(res.body).toEqual({ success: true, recordset: [{ Batch: 'B1' }] });
  });

  test('a DB failure is reported as a 500', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
    const res = await request(app).post('/').send({ tableName: 'Batches', col: 'Batch', mode: 'contains', val: 'B' });
    expect(res.status).toBe(500);
  });

  test('interpolates the allowlisted table name and validated column into the query text', async () => {
    queueResults({ recordset: [] });
    await request(app).post('/').send({ tableName: 'EwaldBoxes', col: 'BoxID', mode: 'contains', val: 'x' });
    expect(dbRequest.query.mock.calls[0][0]).toBe('SELECT TOP 500 * FROM dbo.EwaldBoxes WHERE BoxID LIKE @val');
  });
});

// Unfiltered "load table" call (col/mode/val all omitted) -- what
// private/js/production.js's loadTable() now sends instead of hitting
// /sql/query directly, since /sql/query is hardcoded to the Nexus database
// and doesn't know these legacy tables live in NexusArchive.
describe('unfiltered load (col/mode/val all omitted)', () => {
  test('runs an unqualified TOP 500 with no WHERE clause and no bound value', async () => {
    queueResults({ recordset: [{ Batch: 'B1' }] });
    const res = await request(app).post('/').send({ tableName: 'Batches' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, recordset: [{ Batch: 'B1' }] });
    expect(dbRequest.query.mock.calls[0][0]).toBe('SELECT TOP 500 * FROM dbo.Batches');
    expect(dbRequest.input).not.toHaveBeenCalled();
  });

  test('still 403s a table not on the allowlist', async () => {
    const res = await request(app).post('/').send({ tableName: 'PortalUsers' });
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('400s a partial filter (col present, mode/val missing) rather than silently treating it as unfiltered', async () => {
    const res = await request(app).post('/').send({ tableName: 'Batches', col: 'Batch' });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });
});
