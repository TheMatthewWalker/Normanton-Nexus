// routes/bapiInspector.js is a superadmin-gated proxy in front of
// SapServer's GET /api/function/params — mocking axios (called as a
// function, not .get/.post, since a GET-with-body needs the explicit
// { method: 'get', ... } form) and mssql (for auditQuery) covers the
// requireSuperadmin gate, the missing-functionName validation, and the
// success/error proxy paths, same pattern as test/routes/sap.test.js.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser, adminUser, superadminUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const axiosMock = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

let bapiRouter;
let appOperator;
let appAdmin;
let appSuperadmin;

beforeAll(async () => {
  ({ default: bapiRouter } = await import('../../routes/bapiInspector.js'));
  appOperator   = buildTestApp(bapiRouter, { sessionUser: operatorUser });
  appAdmin      = buildTestApp(bapiRouter, { sessionUser: adminUser });
  appSuperadmin = buildTestApp(bapiRouter, { sessionUser: superadminUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  axiosMock.mockReset();
  dbRequest.query.mockResolvedValue({ recordset: [] }); // audit inserts always succeed unless overridden
});

describe('POST /lookup', () => {
  test('rejects a non-superadmin user', async () => {
    const res = await request(appOperator).post('/lookup').send({ functionName: 'BAPI_PO_GETDETAIL1' });
    expect(res.status).toBe(403);
    expect(axiosMock).not.toHaveBeenCalled();
  });

  test('rejects an admin (not superadmin) user', async () => {
    const res = await request(appAdmin).post('/lookup').send({ functionName: 'BAPI_PO_GETDETAIL1' });
    expect(res.status).toBe(403);
    expect(axiosMock).not.toHaveBeenCalled();
  });

  test('rejects a request with no functionName', async () => {
    const res = await request(appSuperadmin).post('/lookup').send({});
    expect(res.status).toBe(400);
    expect(axiosMock).not.toHaveBeenCalled();
  });

  test('proxies to SapServer as a GET with a JSON body and a bearer token, returning its data on success', async () => {
    const params = [
      { paramName: 'PURCHASEORDER', direction: 'IMPORT', paramType: '', fields: [] },
      { paramName: 'POITEM', direction: 'TABLE', paramType: 'BAPIMEPOITEM', fields: [
        { fieldName: 'PO_ITEM', fieldType: 'NUMC', length: '5' },
      ] },
    ];
    axiosMock.mockResolvedValueOnce({ data: { success: true, data: params } });

    const res = await request(appSuperadmin).post('/lookup').send({ functionName: 'BAPI_PO_GETDETAIL1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: params });

    const [options] = axiosMock.mock.calls[0];
    expect(options.method).toBe('get');
    expect(options.url).toContain('/api/function/params');
    expect(options.data).toEqual({ functionName: 'BAPI_PO_GETDETAIL1' });
    expect(options.headers.Authorization).toMatch(/^Bearer /);
  });

  test('maps a SapServer error response through with its status and message', async () => {
    const sapError = new Error('request failed');
    sapError.response = { status: 422, data: { error: { message: "'BAPI_PO_GETDETAIL1' has no EXPORTING parameter named 'ITEM_CONDITIONS'." } } };
    axiosMock.mockRejectedValueOnce(sapError);

    const res = await request(appSuperadmin).post('/lookup').send({ functionName: 'BAPI_PO_GETDETAIL1' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("'BAPI_PO_GETDETAIL1' has no EXPORTING parameter named 'ITEM_CONDITIONS'.");
  });
});
