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
      issuer: 'sql2005-bridge',
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
