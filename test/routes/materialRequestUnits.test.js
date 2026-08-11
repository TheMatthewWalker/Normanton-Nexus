// routes/materialRequestUnits.js manages log.MaterialRequestUnits (the
// LOG_ADMIN Material Request Units admin tile) and also exports
// getConversionQty() directly for routes/staging.js's POST /requests to
// call in-process. Real logic worth testing: GET / and GET /by-material/:x
// are open to any logged-in user (no LOG_ADMIN gate — Staging Post's
// request form needs to read this without that permission), writes require
// LOG_ADMIN, the UQ_MaterialRequestUnits_Material_Unit duplicate-key
// rewrite, the CSV /bulk upsert's insert-vs-update counting and per-row
// error collection, and getConversionQty's exact-match-then-throw behavior.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const logAdmin = { ...operatorUser, permissions: ['LOG_ADMIN'] };

let router;
let getConversionQty;
let app;
let appAdmin;

beforeAll(async () => {
  ({ default: router, getConversionQty } = await import('../../routes/materialRequestUnits.js'));
  app = buildTestApp(router, { sessionUser: operatorUser });
  appAdmin = buildTestApp(router, { sessionUser: logAdmin });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET /', () => {
  test('does not require LOG_ADMIN', async () => {
    queueResults({ recordset: [{ RequestUnitId: 1, Material: '30007R', Unit: 'Spool', ConversionQty: 20 }] });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ RequestUnitId: 1, Material: '30007R', Unit: 'Spool', ConversionQty: 20 }]);
  });
});

describe('GET /by-material/:material', () => {
  test('does not require LOG_ADMIN and scopes to the given material', async () => {
    queueResults({ recordset: [{ RequestUnitId: 1, Material: '30007R', Unit: 'Spool', ConversionQty: 20 }] });
    const res = await request(app).get('/by-material/30007R');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const materialInput = dbRequest.input.mock.calls.find(c => c[0] === 'material');
    expect(materialInput[2]).toBe('30007R');
  });

  test('returns an empty list for a material with no configured units', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).get('/by-material/UNKNOWN');
    expect(res.body.data).toEqual([]);
  });
});

describe('POST /', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).post('/').send({ material: '30007R', unit: 'Spool', conversionQty: 20 });
    expect(res.status).toBe(403);
  });

  test('requires material', async () => {
    const res = await request(appAdmin).post('/').send({ unit: 'Spool', conversionQty: 20 });
    expect(res.status).toBe(400);
  });

  test('requires unit', async () => {
    const res = await request(appAdmin).post('/').send({ material: '30007R', conversionQty: 20 });
    expect(res.status).toBe(400);
  });

  test('requires a positive conversionQty', async () => {
    const res = await request(appAdmin).post('/').send({ material: '30007R', unit: 'Spool', conversionQty: 0 });
    expect(res.status).toBe(400);
  });

  test('creates a conversion', async () => {
    queueResults({ recordset: [{ RequestUnitId: 7 }] });
    const res = await request(appAdmin).post('/').send({ material: '30007r', unit: 'Spool', conversionQty: 20 });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ requestUnitId: 7 });
  });

  test('rewrites a duplicate-key violation into a friendly message', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('Violation of UNIQUE KEY constraint UQ_MaterialRequestUnits_Material_Unit. blah'));
    const res = await request(appAdmin).post('/').send({ material: '30007R', unit: 'Spool', conversionQty: 20 });
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('A conversion for 30007R / Spool already exists.');
  });

  test('leaves an unrelated SQL error message untouched', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
    const res = await request(appAdmin).post('/').send({ material: '30007R', unit: 'Spool', conversionQty: 20 });
    expect(res.body.error.message).toBe('connection lost');
  });
});

describe('PUT /:id', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).put('/1').send({ material: '30007R', unit: 'Spool', conversionQty: 20 });
    expect(res.status).toBe(403);
  });

  test('400s on a missing/invalid conversionQty', async () => {
    const res = await request(appAdmin).put('/1').send({ material: '30007R', unit: 'Spool', conversionQty: -1 });
    expect(res.status).toBe(400);
  });

  test('updates a conversion', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAdmin).put('/1').send({ material: '30007R', unit: 'Spool', conversionQty: 25 });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /:id', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).delete('/1');
    expect(res.status).toBe(403);
  });

  test('deletes a conversion', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAdmin).delete('/1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /bulk', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).post('/bulk').send({ records: [{ material: '30007R', unit: 'Spool', conversionQty: 20 }] });
    expect(res.status).toBe(403);
  });

  test('400s on an empty/missing records array', async () => {
    const res = await request(appAdmin).post('/bulk').send({ records: [] });
    expect(res.status).toBe(400);
  });

  test('counts an INSERT action from the MERGE as inserted', async () => {
    queueResults({ recordset: [{ Action: 'INSERT' }] });
    const res = await request(appAdmin).post('/bulk').send({ records: [{ material: '30007R', unit: 'Spool', conversionQty: 20 }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ inserted: 1, updated: 0, errors: [] });
  });

  test('counts an UPDATE action from the MERGE as updated', async () => {
    queueResults({ recordset: [{ Action: 'UPDATE' }] });
    const res = await request(appAdmin).post('/bulk').send({ records: [{ material: '30007R', unit: 'Spool', conversionQty: 25 }] });
    expect(res.body).toMatchObject({ inserted: 0, updated: 1 });
  });

  test('collects a row-level validation error without aborting the batch', async () => {
    queueResults({ recordset: [{ Action: 'INSERT' }] });
    const res = await request(appAdmin).post('/bulk').send({
      records: [
        { material: '', unit: 'Spool', conversionQty: 20 },
        { material: '30007R', unit: 'Tub', conversionQty: 15 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(1);
    expect(res.body.errors).toEqual([{ material: '', unit: 'Spool', error: 'material is required.' }]);
  });

  test('collects a DB-level error for one row without aborting the batch', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('constraint violation'));
    const res = await request(appAdmin).post('/bulk').send({ records: [{ material: '30007R', unit: 'Spool', conversionQty: 20 }] });
    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([{ material: '30007R', unit: 'Spool', error: 'constraint violation' }]);
  });
});

describe('getConversionQty (called in-process by routes/staging.js)', () => {
  test('returns the ConversionQty for an exact (material, unit) match', async () => {
    queueResults({ recordset: [{ ConversionQty: 20 }] });
    const result = await getConversionQty('30007R', 'Spool');
    expect(result).toBe(20);
  });

  test('throws a specific error naming the missing material/unit combination', async () => {
    queueResults({ recordset: [] });
    await expect(getConversionQty('30007R', 'Pallet')).rejects.toThrow(
      /No conversion configured for Pallet of 30007R/,
    );
  });
});
