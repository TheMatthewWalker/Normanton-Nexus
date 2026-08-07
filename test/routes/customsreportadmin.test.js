// routes/customsreportadmin.js manages the two small admin-maintained
// fallback tables backing the Customs Report (dbo.CustomsVatNumberOverrides,
// dbo.CustomsHsCodeDescriptions) and also exports lookupVatOverride()/
// lookupHsDescription() directly for routes/customsreport.js to call
// in-process. Real logic worth testing: the duplicate-key error rewrites for
// both tables, and the two lookup helpers' present/absent behavior.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const logAdmin = { ...operatorUser, permissions: ['LOG_ADMIN'] };

let customsReportAdminRouter;
let lookupVatOverride;
let lookupHsDescription;
let app;
let appAdmin;

beforeAll(async () => {
  ({ default: customsReportAdminRouter, lookupVatOverride, lookupHsDescription } = await import('../../routes/customsreportadmin.js'));
  app = buildTestApp(customsReportAdminRouter, { sessionUser: operatorUser });
  appAdmin = buildTestApp(customsReportAdminRouter, { sessionUser: logAdmin });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET /vat-overrides', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).get('/vat-overrides');
    expect(res.status).toBe(403);
  });

  test('returns the override list', async () => {
    queueResults({ recordset: [{ OverrideId: 1, ConsigneeCode: '363533', VatNumber: 'SK2120170316' }] });
    const res = await request(appAdmin).get('/vat-overrides');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ OverrideId: 1, ConsigneeCode: '363533', VatNumber: 'SK2120170316' }]);
  });
});

describe('POST /vat-overrides', () => {
  test('400s without consigneeCode', async () => {
    const res = await request(appAdmin).post('/vat-overrides').send({ vatNumber: 'SK2120170316' });
    expect(res.status).toBe(400);
  });

  test('400s without vatNumber', async () => {
    const res = await request(appAdmin).post('/vat-overrides').send({ consigneeCode: '363533' });
    expect(res.status).toBe(400);
  });

  test('creates an override', async () => {
    queueResults({ recordset: [{ OverrideId: 5 }] });
    const res = await request(appAdmin).post('/vat-overrides').send({ consigneeCode: '363533', vatNumber: 'SK2120170316' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ overrideId: 5 });
  });

  test('rewrites a duplicate-key violation into a friendly message', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('Violation of UNIQUE KEY constraint UQ_CustomsVatNumberOverrides_Consignee. blah'));
    const res = await request(appAdmin).post('/vat-overrides').send({ consigneeCode: '363533', vatNumber: 'SK2120170316' });
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('A VAT override for consignee 363533 already exists.');
  });
});

describe('DELETE /vat-overrides/:overrideId', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).delete('/vat-overrides/1');
    expect(res.status).toBe(403);
  });

  test('deletes an override', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAdmin).delete('/vat-overrides/1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /hs-descriptions', () => {
  test('400s without commodityCode', async () => {
    const res = await request(appAdmin).post('/hs-descriptions').send({ description: 'PTFE Hose' });
    expect(res.status).toBe(400);
  });

  test('creates a description', async () => {
    queueResults({ recordset: [{ HsCodeId: 7 }] });
    const res = await request(appAdmin).post('/hs-descriptions').send({ commodityCode: '39173900', description: 'PTFE Hose' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ hsCodeId: 7 });
  });

  test('rewrites a duplicate-key violation into a friendly message', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('Violation of UNIQUE KEY constraint UQ_CustomsHsCodeDescriptions_Code. blah'));
    const res = await request(appAdmin).post('/hs-descriptions').send({ commodityCode: '39173900', description: 'PTFE Hose' });
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('A description for commodity code 39173900 already exists.');
  });
});

describe('lookupVatOverride (called in-process by customsreport.js)', () => {
  test('returns the VAT number when a row exists', async () => {
    queueResults({ recordset: [{ VatNumber: 'SK2120170316' }] });
    const result = await lookupVatOverride('363533');
    expect(result).toBe('SK2120170316');
  });

  test('returns null when nothing matches', async () => {
    queueResults({ recordset: [] });
    const result = await lookupVatOverride('999999');
    expect(result).toBeNull();
  });

  test('returns null for an empty consignee code without querying', async () => {
    const result = await lookupVatOverride('');
    expect(result).toBeNull();
    expect(dbRequest.query).not.toHaveBeenCalled();
  });
});

describe('lookupHsDescription (called in-process by customsreport.js)', () => {
  test('returns the description when a row exists', async () => {
    queueResults({ recordset: [{ Description: 'PTFE Hose' }] });
    const result = await lookupHsDescription('39173900');
    expect(result).toBe('PTFE Hose');
  });

  test('returns null when nothing matches', async () => {
    queueResults({ recordset: [] });
    const result = await lookupHsDescription('00000000');
    expect(result).toBeNull();
  });
});
