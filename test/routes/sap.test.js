// routes/sap.js is a proxy layer: validate the request, call out to
// SapServer via axios, audit the result. Mocking mssql (for the audit
// helper) and axios (for the actual SAP calls) covers the pattern shared by
// its ~20 near-identical endpoints — a representative sample is tested here
// rather than every proxy route individually.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const axiosMock = { get: jest.fn(), post: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

const logSuperUser = { ...operatorUser, permissions: ['LOG_SUPER'] };

let sapRouter;
let app;
let appLogSuper;

beforeAll(async () => {
  ({ default: sapRouter } = await import('../../routes/sap.js'));
  app = buildTestApp(sapRouter, { sessionUser: operatorUser });
  appLogSuper = buildTestApp(sapRouter, { sessionUser: logSuperUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  axiosMock.get.mockReset();
  axiosMock.post.mockReset();
  dbRequest.query.mockResolvedValue({ recordset: [] }); // audit inserts always succeed unless overridden
});

describe('POST /token', () => {
  test('issues a JWT carrying the session user\'s identity and departments', async () => {
    const res = await request(app).post('/token');

    expect(res.status).toBe(200);
    const decoded = jwt.verify(res.body.token, process.env.SAP_SERVER_SECRET, {
      issuer: 'normanton-nexus',
      audience: 'sap-server',
    });
    expect(decoded).toMatchObject({
      userId: operatorUser.userID,
      username: operatorUser.username,
      role: operatorUser.role,
      departments: operatorUser.departments,
    });
  });
});

describe('POST /execute-rfc', () => {
  test('rejects a request with no functionName', async () => {
    const res = await request(app).post('/execute-rfc').send({});
    expect(res.status).toBe(400);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('proxies to SapServer with a bearer token and returns its data on success', async () => {
    axiosMock.post.mockResolvedValueOnce({ data: { success: true, data: { parameters: { STATUS: 'OK' } } } });

    const res = await request(app).post('/execute-rfc').send({ functionName: 'RFC_PING' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { success: true, data: { parameters: { STATUS: 'OK' } } } });

    const [url, body, options] = axiosMock.post.mock.calls[0];
    expect(url).toContain('/api/rfc/execute');
    expect(body.functionName).toBe('RFC_PING');
    expect(options.headers.Authorization).toMatch(/^Bearer /);
  });

  test('maps a SapServer error response through with its status and message', async () => {
    const sapError = new Error('request failed');
    sapError.response = { status: 422, data: { error: { message: 'Material 30005R does not exist' } } };
    axiosMock.post.mockRejectedValueOnce(sapError);

    const res = await request(app).post('/execute-rfc').send({ functionName: 'ZF40N' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Material 30005R does not exist');
  });
});

describe('POST /cost-sheet', () => {
  test('rejects a request whose items is not an array', async () => {
    const res = await request(app).post('/cost-sheet').send({ date: '2026-01-01' });
    expect(res.status).toBe(400);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });
});

describe('POST /warehouse/stock-adjustment', () => {
  test('is rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).post('/warehouse/stock-adjustment').send({ Material: '30005R' });
    expect(res.status).toBe(403);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('appends ?dryRun=true to the SapServer URL when requested', async () => {
    axiosMock.post.mockResolvedValueOnce({ data: { success: true, data: {} } });

    const res = await request(appLogSuper)
      .post('/warehouse/stock-adjustment?dryRun=true')
      .send({ Material: '30005R', MovementType: '711' });

    expect(res.status).toBe(200);
    const [url] = axiosMock.post.mock.calls[0];
    expect(url).toContain('?dryRun=true');
  });

  test('maps a body-level success:false as a failure', async () => {
    axiosMock.post.mockResolvedValueOnce({ data: { success: false, error: 'No components in BOM' } });

    const res = await request(appLogSuper).post('/warehouse/stock-adjustment').send({ Material: '30005R' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('No components in BOM');
  });
});

describe('GET /warehouse/open-transfer-requirements', () => {
  test('forwards material, storageLocation and createdBy alongside mrpController', async () => {
    axiosMock.get.mockResolvedValueOnce({ data: { success: true, data: [] } });

    await request(app)
      .get('/warehouse/open-transfer-requirements')
      .query({ mrpController: '101', material: '30005R', storageLocation: '1710', createdBy: 'jsmith' });

    const [, options] = axiosMock.get.mock.calls[0];
    expect(options.params).toEqual({
      mrpController: '101', material: '30005R', storageLocation: '1710', createdBy: 'jsmith',
    });
  });
});

describe('GET /warehouse/bin-storage-types', () => {
  test('proxies the bin query param and returns SapServer\'s data', async () => {
    axiosMock.get.mockResolvedValueOnce({ data: { success: true, data: ['SA'] } });

    const res = await request(app).get('/warehouse/bin-storage-types').query({ bin: '123' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: ['SA'] });
    const [, options] = axiosMock.get.mock.calls[0];
    expect(options.params).toEqual({ bin: '123' });
  });

  // Deliberately not audited (unlike every other GET route in this file) —
  // fires far too often (blur/Enter on up to 7 form fields) to be worth
  // logging every call. This test locks in that intentional deviation.
  test('does not write an audit entry, unlike the other warehouse GET proxies', async () => {
    axiosMock.get.mockResolvedValueOnce({ data: { success: true, data: ['SA'] } });

    await request(app).get('/warehouse/bin-storage-types').query({ bin: '123' });

    expect(dbRequest.query).not.toHaveBeenCalled();
  });
});

describe('GET /warehouse/tr-cleanup-candidates', () => {
  test('returns SapServer\'s candidate list and audits success', async () => {
    axiosMock.get.mockResolvedValueOnce({ data: { success: true, data: [{ trNumber: '4500001111', reasons: ['sloc_1710'] }] } });

    const res = await request(app).get('/warehouse/tr-cleanup-candidates');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(dbRequest.query).toHaveBeenCalledTimes(1); // the audit insert
  });

  test('audits failure and maps the SapServer error through', async () => {
    const sapError = new Error('request failed');
    sapError.response = { status: 500, data: { error: 'SAP unavailable' } };
    axiosMock.get.mockRejectedValueOnce(sapError);

    const res = await request(app).get('/warehouse/tr-cleanup-candidates');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('SAP unavailable');
    expect(dbRequest.query).toHaveBeenCalledTimes(1); // the audit insert
  });
});

describe('POST /warehouse/delete-tr', () => {
  test('is rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).post('/warehouse/delete-tr').send({ TrNumber: '4500001234' });
    expect(res.status).toBe(403);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('proxies the delete for a LOG_SUPER user and audits success', async () => {
    axiosMock.post.mockResolvedValueOnce({ data: { success: true, data: { type: 'S', message: 'Transfer requirement deleted' } } });

    const res = await request(appLogSuper).post('/warehouse/delete-tr').send({ TrNumber: '4500001234' });

    expect(res.status).toBe(200);
    const [, body] = axiosMock.post.mock.calls[0];
    expect(body).toEqual({ TrNumber: '4500001234' });
    expect(dbRequest.query).toHaveBeenCalledTimes(1); // the audit insert
  });

  test('audits failure and maps the SapServer error through', async () => {
    const sapError = new Error('request failed');
    sapError.response = { status: 422, data: { error: 'RFC call failed' } };
    axiosMock.post.mockRejectedValueOnce(sapError);

    const res = await request(appLogSuper).post('/warehouse/delete-tr').send({ TrNumber: '4500001234' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('RFC call failed');
    expect(dbRequest.query).toHaveBeenCalledTimes(1); // the audit insert
  });
});

describe('POST /lips', () => {
  test('rejects an empty/missing deliveries array', async () => {
    const res = await request(app).post('/lips').send({});
    expect(res.status).toBe(400);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('proxies a non-empty deliveries array to SapServer', async () => {
    axiosMock.post.mockResolvedValueOnce({ data: { success: true, data: [] } });

    const res = await request(app).post('/lips').send({ deliveries: ['80001234'] });

    expect(res.status).toBe(200);
    const [url, body] = axiosMock.post.mock.calls[0];
    expect(url).toContain('/api/customs/lips');
    expect(body.deliveries).toEqual(['80001234']);
  });
});

describe('POST /vbrk', () => {
  test('rejects an empty/missing invoices array', async () => {
    const res = await request(app).post('/vbrk').send({});
    expect(res.status).toBe(400);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('proxies a non-empty invoices array to SapServer', async () => {
    axiosMock.post.mockResolvedValueOnce({ data: { success: true, data: [{ invoiceNumber: '6123356', currency: 'EUR' }] } });

    const res = await request(app).post('/vbrk').send({ invoices: ['6123356'] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ invoiceNumber: '6123356', currency: 'EUR' }]);
    const [url, body] = axiosMock.post.mock.calls[0];
    expect(url).toContain('/api/customs/vbrk');
    expect(body.invoices).toEqual(['6123356']);
  });

  test('maps a SapServer error response through with its status and message', async () => {
    const sapError = new Error('request failed');
    sapError.response = { status: 502, data: { error: 'SAP unavailable' } };
    axiosMock.post.mockRejectedValueOnce(sapError);

    const res = await request(app).post('/vbrk').send({ invoices: ['6123356'] });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('SAP unavailable');
  });
});

describe('POST /consignment-price', () => {
  test('rejects an empty/missing lines array', async () => {
    const res = await request(app).post('/consignment-price').send({});
    expect(res.status).toBe(400);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('proxies a non-empty lines array to SapServer', async () => {
    axiosMock.post.mockResolvedValueOnce({ data: { success: true, data: [] } });

    const res = await request(app).post('/consignment-price').send({ lines: [{ customer: '363533', material: 'CP1166' }] });

    expect(res.status).toBe(200);
    const [url, body] = axiosMock.post.mock.calls[0];
    expect(url).toContain('/api/customs/consignment-price');
    expect(body.lines).toEqual([{ customer: '363533', material: 'CP1166' }]);
  });
});
