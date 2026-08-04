// routes/packaging.js proxies Engineering's packaging-data tools to
// SapServer (axios, mocked) and gates every write behind MASTER_DATA on top
// of plain engineering-department view access. Real logic worth testing:
// sapGet/sapPost's success:false -> throw(with .status) unwrapping, GET
// /material/:material/instruction's "404 = not set up yet, not an error"
// special case, PUT/DELETE /instruction's validation + audit details, mass
// -update's per-row validation and success-count audit, and POST /create's
// hard requirement for saved SAP credentials (lib/sapCredentials.js, mocked)
// before it will call the elevated SAP endpoint.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const axiosMock = { get: jest.fn(), request: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

const getDecryptedSapCredentialsMock = jest.fn();
jest.unstable_mockModule('../../lib/sapCredentials.js', () => ({
  getDecryptedSapCredentials: getDecryptedSapCredentialsMock,
}));

const engUser = { ...operatorUser, departments: ['engineering'], permissions: [] };
const engMasterData = { ...operatorUser, departments: ['engineering'], permissions: ['MASTER_DATA'] };

let packagingRouter;
let appNone;
let appView;
let appWrite;

beforeAll(async () => {
  ({ default: packagingRouter } = await import('../../routes/packaging.js'));
  appNone = buildTestApp(packagingRouter, { sessionUser: operatorUser }); // production dept, no engineering access
  appView = buildTestApp(packagingRouter, { sessionUser: engUser });
  appWrite = buildTestApp(packagingRouter, { sessionUser: engMasterData });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  dbRequest.query.mockResolvedValue({ recordset: [] });
  axiosMock.get.mockReset();
  axiosMock.request.mockReset();
  getDecryptedSapCredentialsMock.mockReset();
});

function auditedEventTypes() {
  return dbRequest.input.mock.calls.filter(c => c[0] === 'eventType').map(c => c[2]);
}

describe('view gate (requireDepartment engineering)', () => {
  test('403s a non-engineering user', async () => {
    const res = await request(appNone).get('/materials').set('Accept', 'application/json');
    expect(res.status).toBe(403);
  });
});

describe('GET /materials', () => {
  test('searches TurnsValClassSnapshot with a wildcard when a search term is given', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ material: 'M1', materialText: 'Widget' }] });
    const res = await request(appView).get('/materials').query({ search: 'Widget' });
    expect(res.body.data).toEqual([{ material: 'M1', materialText: 'Widget' }]);
    expect(dbRequest.input).toHaveBeenCalledWith('search', expect.anything(), '%Widget%');
  });
});

describe('sapGet-based material lookups', () => {
  test('GET /material/:material/exists unwraps a successful SapServer response', async () => {
    axiosMock.get.mockResolvedValueOnce({ status: 200, data: { success: true, data: { exists: true } } });
    const res = await request(appView).get('/material/M1/exists');
    expect(res.body).toEqual({ success: true, data: { exists: true } });
  });

  test('a success:false SapServer response is surfaced as a 500 with its message', async () => {
    axiosMock.get.mockResolvedValueOnce({ status: 502, data: { success: false, error: { message: 'SapServer unreachable' } } });
    const res = await request(appView).get('/material/M1/exists');
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('SapServer unreachable');
  });
});

describe('GET /material/:material/instruction — 404-as-not-set-up handling', () => {
  test('a 404 from SapServer (no instruction row yet) returns success:true, data:null — not an error', async () => {
    axiosMock.get.mockResolvedValueOnce({ status: 404, data: { success: false, error: { message: 'No packaging instruction found.' } } });
    const res = await request(appView).get('/material/M1/instruction');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: null });
  });

  test('a genuine SapServer error (not a 404/"No ..." message) is still a 500', async () => {
    axiosMock.get.mockResolvedValueOnce({ status: 502, data: { success: false, error: { message: 'Connection reset' } } });
    const res = await request(appView).get('/material/M1/instruction');
    expect(res.status).toBe(500);
  });

  test('passes the customer query param through to SapServer', async () => {
    axiosMock.get.mockResolvedValueOnce({ status: 200, data: { success: true, data: {} } });
    await request(appView).get('/material/M1/instruction').query({ customer: 'C1' });
    expect(axiosMock.get.mock.calls[0][1].params).toEqual({ customer: 'C1' });
  });
});

describe('PUT /instruction', () => {
  test('403s without MASTER_DATA', async () => {
    const res = await request(appView).put('/instruction').send({ material: 'M1' });
    expect(res.status).toBe(403);
  });

  test('400s without material', async () => {
    const res = await request(appWrite).put('/instruction').send({});
    expect(res.status).toBe(400);
  });

  test('saves and audits with the customer name when set', async () => {
    axiosMock.request.mockResolvedValueOnce({ status: 200, data: { success: true, data: { ok: true } } });
    const res = await request(appWrite).put('/instruction').send({ material: 'M1', customer: 'C1', packMaterial: 'DR' });
    expect(res.status).toBe(200);
    expect(auditedEventTypes()).toEqual(['PACKAGING_INSTRUCTION_SAVED']);
    const detail = dbRequest.input.mock.calls.find(c => c[0] === 'detail')[2];
    expect(detail).toBe('M1 / C1 — pack material DR');
  });

  test('audits "(plant default)" when no customer is given', async () => {
    axiosMock.request.mockResolvedValueOnce({ status: 200, data: { success: true, data: {} } });
    await request(appWrite).put('/instruction').send({ material: 'M1', packMaterial: 'DR' });
    const detail = dbRequest.input.mock.calls.find(c => c[0] === 'detail')[2];
    expect(detail).toBe('M1 (plant default) — pack material DR');
  });

  test('a 422 validation failure from SapServer is passed through as 422', async () => {
    axiosMock.request.mockResolvedValueOnce({ status: 422, data: { success: false, error: { message: 'Pack material does not exist' } } });
    const res = await request(appWrite).put('/instruction').send({ material: 'M1', packMaterial: 'BAD' });
    expect(res.status).toBe(422);
  });
});

describe('DELETE /instruction', () => {
  test('403s without MASTER_DATA', async () => {
    const res = await request(appView).delete('/instruction').send({ material: 'M1' });
    expect(res.status).toBe(403);
  });

  test('400s without material', async () => {
    const res = await request(appWrite).delete('/instruction').send({});
    expect(res.status).toBe(400);
  });

  test('deletes and audits', async () => {
    axiosMock.request.mockResolvedValueOnce({ status: 200, data: { success: true, data: {} } });
    const res = await request(appWrite).delete('/instruction').send({ material: 'M1', customer: 'C1' });
    expect(res.status).toBe(200);
    expect(auditedEventTypes()).toEqual(['PACKAGING_INSTRUCTION_DELETED']);
  });
});

describe('POST /mass-update', () => {
  test('403s without MASTER_DATA', async () => {
    const res = await request(appView).post('/mass-update').send({ rows: [] });
    expect(res.status).toBe(403);
  });

  test('400s on an empty rows array', async () => {
    const res = await request(appWrite).post('/mass-update').send({ rows: [] });
    expect(res.status).toBe(400);
  });

  test('400s when a row is missing material or packMaterial', async () => {
    const res = await request(appWrite).post('/mass-update').send({ rows: [{ material: 'M1' }] });
    expect(res.status).toBe(400);
    expect(axiosMock.request).not.toHaveBeenCalled();
  });

  test('audits the success count out of the total rows', async () => {
    axiosMock.request.mockResolvedValueOnce({
      status: 200,
      data: { success: true, data: [{ material: 'M1', success: true }, { material: 'M2', success: false }] },
    });
    const res = await request(appWrite).post('/mass-update').send({
      rows: [{ material: 'M1', packMaterial: 'DR' }, { material: 'M2', packMaterial: 'DR' }],
    });
    expect(res.status).toBe(200);
    const detail = dbRequest.input.mock.calls.find(c => c[0] === 'detail')[2];
    expect(detail).toBe('1/2 materials updated');
  });
});

describe('POST /create', () => {
  test('403s without MASTER_DATA', async () => {
    const res = await request(appView).post('/create').send({ customerPart: 'P1' });
    expect(res.status).toBe(403);
  });

  test('400s without customerPart', async () => {
    const res = await request(appWrite).post('/create').send({});
    expect(res.status).toBe(400);
  });

  test('400s with a clear message when the user has no saved SAP credentials', async () => {
    getDecryptedSapCredentialsMock.mockResolvedValueOnce(null);
    const res = await request(appWrite).post('/create').send({ customerPart: 'P1', codes: ['DR'] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/save your SAP username and password/);
    expect(axiosMock.request).not.toHaveBeenCalled();
  });

  test('calls the elevated endpoint with the decrypted credentials and audits the created count', async () => {
    getDecryptedSapCredentialsMock.mockResolvedValueOnce({ sapUsername: 'J.SMITH', sapPassword: 'S3cret!' });
    axiosMock.request.mockResolvedValueOnce({
      status: 200,
      data: { success: true, data: [{ code: 'DR', materialCreated: true }, { code: 'MX', materialCreated: false }] },
    });
    const res = await request(appWrite).post('/create').send({ customerPart: 'P1', codes: ['DR', 'MX'] });
    expect(res.status).toBe(200);
    expect(axiosMock.request.mock.calls[0][0]).toMatchObject({
      url: expect.stringContaining('/create-elevated'),
      data: expect.objectContaining({ SapUsername: 'J.SMITH', SapPassword: 'S3cret!', CustomerPart: 'P1' }),
    });
    const detail = dbRequest.input.mock.calls.find(c => c[0] === 'detail')[2];
    expect(detail).toBe('P1 — 1 materials created');
  });
});
