// routes/materialgroups.js manages dbo.MaterialGroupMapping (the LOG_ADMIN
// admin tile) and also exports lookupMaterialGroup() directly for
// shipmentcost.js's post-migo to call in-process. Real logic worth testing:
// the UQ_MGM_CostElement_ModeKey duplicate-key error rewrite (with/without
// a mode suffix), and lookupMaterialGroup's exact-match-then-default
// fallback plus its deliberate throw when nothing matches.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const logAdmin = { ...operatorUser, permissions: ['LOG_ADMIN'] };

let materialGroupsRouter;
let lookupMaterialGroup;
let app;
let appAdmin;

beforeAll(async () => {
  ({ default: materialGroupsRouter, lookupMaterialGroup } = await import('../../routes/materialgroups.js'));
  app = buildTestApp(materialGroupsRouter, { sessionUser: operatorUser });
  appAdmin = buildTestApp(materialGroupsRouter, { sessionUser: logAdmin });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET /', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(403);
  });

  test('returns the mapping list', async () => {
    queueResults({ recordset: [{ MappingId: 1, MaterialGroup: 'ITLG01A' }] });
    const res = await request(appAdmin).get('/');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ MappingId: 1, MaterialGroup: 'ITLG01A' }]);
  });
});

describe('POST /', () => {
  test('400s without costElement', async () => {
    const res = await request(appAdmin).post('/').send({ materialGroup: 'ITLG01A' });
    expect(res.status).toBe(400);
  });

  test('400s without materialGroup', async () => {
    const res = await request(appAdmin).post('/').send({ costElement: '602100' });
    expect(res.status).toBe(400);
  });

  test('creates a mapping', async () => {
    queueResults({ recordset: [{ MappingId: 5 }] });
    const res = await request(appAdmin).post('/').send({ costElement: '602100', modeOfTransport: 'Road', materialGroup: 'ITLG01A' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ mappingId: 5 });
  });

  test('rewrites a duplicate-key violation into a friendly message naming the mode', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('Violation of UNIQUE KEY constraint UQ_MGM_CostElement_ModeKey. blah'));
    const res = await request(appAdmin).post('/').send({ costElement: '602100', modeOfTransport: 'Road', materialGroup: 'ITLG01A' });
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('A mapping for CostElement 602100 / Road already exists.');
  });

  test('rewrites a duplicate-key violation for the default (no-mode) row', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('Violation of UNIQUE KEY constraint UQ_MGM_CostElement_ModeKey. blah'));
    const res = await request(appAdmin).post('/').send({ costElement: '602100', materialGroup: 'ITLG01A' });
    expect(res.body.error.message).toBe('A mapping for CostElement 602100 (default) already exists.');
  });

  test('leaves an unrelated SQL error message untouched', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
    const res = await request(appAdmin).post('/').send({ costElement: '602100', materialGroup: 'ITLG01A' });
    expect(res.body.error.message).toBe('connection lost');
  });
});

describe('PUT /:mappingId', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).put('/1').send({ costElement: '602100', materialGroup: 'ITLG01A' });
    expect(res.status).toBe(403);
  });

  test('updates a mapping', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAdmin).put('/1').send({ costElement: '602100', materialGroup: 'ITLG01A' });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /:mappingId', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).delete('/1');
    expect(res.status).toBe(403);
  });

  test('deletes a mapping', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAdmin).delete('/1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('lookupMaterialGroup (called in-process by shipmentcost.js)', () => {
  test('returns the exact-match MaterialGroup', async () => {
    queueResults({ recordset: [{ MaterialGroup: 'ITLG01A', ModeOfTransport: 'Road' }] });
    const result = await lookupMaterialGroup('602100', 'Road');
    expect(result).toBe('ITLG01A');
  });

  test('throws a specific error naming the missing combination', async () => {
    queueResults({ recordset: [] });
    await expect(lookupMaterialGroup('602100', 'Air')).rejects.toThrow(
      /No Material Group mapping found for GL account 602100 \/ Air/,
    );
  });

  test('throws with "(none)" when no cost element is given at all', async () => {
    queueResults({ recordset: [] });
    await expect(lookupMaterialGroup(null, null)).rejects.toThrow(/GL account \(none\)/);
  });
});
