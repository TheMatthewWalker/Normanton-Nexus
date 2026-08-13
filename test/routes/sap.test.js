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

describe('POST /warehouse/transfer-order', () => {
  test('audits success with the created TR number in the detail', async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: { success: true, data: { success: true, transferOrderNumber: '4500009999', messages: [] } },
    });

    const res = await request(app).post('/warehouse/transfer-order').send({ Material: '30005R' });

    expect(res.status).toBe(200);
    expect(dbRequest.input).toHaveBeenCalledWith('detail', 'NVarChar(500)', expect.stringContaining('TR 4500009999'));
  });

  test('does not append a TR number to the failure audit detail', async () => {
    const sapError = new Error('request failed');
    sapError.response = { status: 422, data: { error: 'RFC call failed' } };
    axiosMock.post.mockRejectedValueOnce(sapError);

    const res = await request(app).post('/warehouse/transfer-order').send({ Material: '30005R' });

    expect(res.status).toBe(422);
    expect(dbRequest.input).toHaveBeenCalledWith('detail', 'NVarChar(500)', expect.stringContaining('Transfer order failed'));
  });

  // lib/stockCountGuard.js — a Raw Material/Production/Finished Goods count
  // active against the same storage location blocks this endpoint with a
  // 409 before ever calling SapServer.
  test('409s and never calls SapServer when an active count blocks the storage location', async () => {
    dbRequest.query.mockResolvedValueOnce({
      recordset: [{ CountId: 5, CountType: 'RAW_MATERIAL', Status: 'Open' }],
    });

    const res = await request(app).post('/warehouse/transfer-order').send({ Material: '30005R', StorageLocation: '1710' });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('RAW_MATERIAL count #5');
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('does not block when no StorageLocation is given', async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: { success: true, data: { success: true, transferOrderNumber: '4500009999', messages: [] } },
    });

    const res = await request(app).post('/warehouse/transfer-order').send({ Material: '30005R' });

    expect(res.status).toBe(200);
  });
});

describe('POST /warehouse/transfer-order-bulk', () => {
  test('is NOT gated behind LOG_SUPER — an ordinary logged-in user can call it', async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: { success: true, data: { success: true, transferOrderNumber: '4500003333', messages: [] } },
    });

    const res = await request(app)
      .post('/warehouse/transfer-order-bulk')
      .send({ items: [{ kind: 'transfer', payload: { Material: '30005R' } }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ success: true });
  });

  test('400s when items is missing or empty', async () => {
    const res1 = await request(app).post('/warehouse/transfer-order-bulk').send({});
    expect(res1.status).toBe(400);
    const res2 = await request(app).post('/warehouse/transfer-order-bulk').send({ items: [] });
    expect(res2.status).toBe(400);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('fires every item concurrently and returns results in the same order', async () => {
    // Both items are 'transfer' kind deliberately — a 'transfer' item takes
    // one extra await (assertTransfersAllowed) before its axios.post call
    // that a 'consignment' item doesn't, so mixing kinds here would make the
    // axios call order (and therefore which mockResolvedValueOnce answer
    // lands on which item) an artifact of that extra hop rather than of
    // Promise.all(items.map(...)) preserving array order for same-shaped work.
    axiosMock.post
      .mockResolvedValueOnce({ data: { success: true, data: { success: true, transferOrderNumber: '4500001111', messages: [] } } })
      .mockResolvedValueOnce({ data: { success: true, data: { success: true, transferOrderNumber: '4500002222', messages: [] } } });

    const res = await request(app)
      .post('/warehouse/transfer-order-bulk')
      .send({
        items: [
          { kind: 'transfer', payload: { Material: '30005R' } },
          { kind: 'transfer', payload: { Material: '30006R' } },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].data.transferOrderNumber).toBe('4500001111');
    expect(res.body.results[1].data.transferOrderNumber).toBe('4500002222');
    expect(axiosMock.post).toHaveBeenCalledTimes(2);
  });

  test('routes a consignment item to consignment-mb1b and a transfer item to transfer-order', async () => {
    axiosMock.post.mockResolvedValue({
      data: { success: true, data: { success: true, mb1bMessage: 'Posted' } },
    });

    await request(app)
      .post('/warehouse/transfer-order-bulk')
      .send({ items: [{ kind: 'consignment', payload: { Material: '30006R' } }] });

    const [url] = axiosMock.post.mock.calls[0];
    expect(url).toContain('/api/warehouse/consignment-mb1b');
  });

  test('one item failing does not prevent the others from succeeding', async () => {
    const sapError = new Error('request failed');
    sapError.response = { status: 422, data: { error: 'Material 30005R does not exist' } };
    axiosMock.post
      .mockRejectedValueOnce(sapError)
      .mockResolvedValueOnce({ data: { success: true, data: { success: true, transferOrderNumber: '4500002222', messages: [] } } });

    const res = await request(app)
      .post('/warehouse/transfer-order-bulk')
      .send({
        items: [
          { kind: 'transfer', payload: { Material: '30005R' } },
          { kind: 'transfer', payload: { Material: '30006R' } },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ success: false, error: 'Material 30005R does not exist' });
    expect(res.body.results[1]).toMatchObject({ success: true });
  });

  test('an active count blocking one item surfaces as a failed result, not an HTTP 409 for the whole batch', async () => {
    dbRequest.query.mockResolvedValueOnce({
      recordset: [{ CountId: 7, CountType: 'PRODUCTION', Status: 'PendingApproval' }],
    });
    axiosMock.post.mockResolvedValue({
      data: { success: true, data: { success: true, transferOrderNumber: '4500002222', messages: [] } },
    });

    const res = await request(app)
      .post('/warehouse/transfer-order-bulk')
      .send({
        items: [
          { kind: 'transfer', payload: { Material: '30005R', StorageLocation: '1716' } },
          { kind: 'transfer', payload: { Material: '30006R', StorageLocation: '1717' } },
        ],
      });

    expect(res.status).toBe(200);
    const successes = res.body.results.filter(r => r.success);
    const failures  = res.body.results.filter(r => !r.success);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });
});

describe('POST /warehouse/batch-cleanup-transfer', () => {
  test('is rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).post('/warehouse/batch-cleanup-transfer').send({ kind: 'transfer', payload: {} });
    expect(res.status).toBe(403);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('400s on an unrecognised kind', async () => {
    const res = await request(appLogSuper).post('/warehouse/batch-cleanup-transfer').send({ kind: 'bogus', payload: {} });
    expect(res.status).toBe(400);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('audits a transfer clean-up success with the created TR number in the detail', async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: { success: true, data: { success: true, transferOrderNumber: '4500008888', messages: [] } },
    });

    const res = await request(appLogSuper)
      .post('/warehouse/batch-cleanup-transfer')
      .send({ kind: 'transfer', payload: { Material: '30005R', Batch: 'B1' } });

    expect(res.status).toBe(200);
    expect(dbRequest.input).toHaveBeenCalledWith('detail', 'NVarChar(500)', expect.stringContaining('TR 4500008888'));
  });

  test('does not look for a TR number on a consignment clean-up', async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: { success: true, data: { success: true, mb1bMessage: 'Posted', toNonConsignMessage: '', toConsignMessage: '' } },
    });

    const res = await request(appLogSuper)
      .post('/warehouse/batch-cleanup-transfer')
      .send({ kind: 'consignment', payload: { Material: '30005R', Batch: 'B1' } });

    expect(res.status).toBe(200);
    const detailCall = dbRequest.input.mock.calls.find(c => c[0] === 'detail');
    expect(detailCall[2]).not.toContain('TR ');
  });

  test('409s a transfer clean-up when an active count blocks the storage location', async () => {
    dbRequest.query.mockResolvedValueOnce({
      recordset: [{ CountId: 7, CountType: 'PRODUCTION', Status: 'PendingApproval' }],
    });

    const res = await request(appLogSuper)
      .post('/warehouse/batch-cleanup-transfer')
      .send({ kind: 'transfer', payload: { Material: '30005R', StorageLocation: '1716' } });

    expect(res.status).toBe(409);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('does not check the guard for a consignment clean-up (not a bin-to-bin transfer)', async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: { success: true, data: { success: true, mb1bMessage: 'Posted', toNonConsignMessage: '', toConsignMessage: '' } },
    });

    const res = await request(appLogSuper)
      .post('/warehouse/batch-cleanup-transfer')
      .send({ kind: 'consignment', payload: { Material: '30005R', StorageLocation: '1716' } });

    expect(res.status).toBe(200);
  });
});

describe('POST /warehouse/batch-cleanup-transfer-bulk', () => {
  test('is rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).post('/warehouse/batch-cleanup-transfer-bulk').send({ items: [{ kind: 'transfer', payload: {} }] });
    expect(res.status).toBe(403);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('400s when items is missing or empty', async () => {
    const res1 = await request(appLogSuper).post('/warehouse/batch-cleanup-transfer-bulk').send({});
    expect(res1.status).toBe(400);
    const res2 = await request(appLogSuper).post('/warehouse/batch-cleanup-transfer-bulk').send({ items: [] });
    expect(res2.status).toBe(400);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('fires every item concurrently and returns results in the same order', async () => {
    axiosMock.post
      .mockResolvedValueOnce({ data: { success: true, data: { success: true, transferOrderNumber: '4500001111', messages: [] } } })
      .mockResolvedValueOnce({ data: { success: true, data: { success: true, transferOrderNumber: '4500002222', messages: [] } } });

    const res = await request(appLogSuper)
      .post('/warehouse/batch-cleanup-transfer-bulk')
      .send({
        items: [
          { kind: 'transfer', payload: { Material: '30005R', Batch: 'B1' } },
          { kind: 'transfer', payload: { Material: '30006R', Batch: 'B2' } },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].data.transferOrderNumber).toBe('4500001111');
    expect(res.body.results[1].data.transferOrderNumber).toBe('4500002222');
    expect(axiosMock.post).toHaveBeenCalledTimes(2);
  });

  test('one item failing does not prevent the others from succeeding', async () => {
    const sapError = new Error('request failed');
    sapError.response = { status: 422, data: { error: { message: 'Material 30005R does not exist' } } };
    axiosMock.post
      .mockRejectedValueOnce(sapError)
      .mockResolvedValueOnce({ data: { success: true, data: { success: true, transferOrderNumber: '4500002222', messages: [] } } });

    const res = await request(appLogSuper)
      .post('/warehouse/batch-cleanup-transfer-bulk')
      .send({
        items: [
          { kind: 'transfer', payload: { Material: '30005R', Batch: 'B1' } },
          { kind: 'transfer', payload: { Material: '30006R', Batch: 'B2' } },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ success: false, error: 'Material 30005R does not exist' });
    expect(res.body.results[1]).toMatchObject({ success: true });
  });

  test('409-worthy TransferBlockedError on one item surfaces as a failed result, not an HTTP 409 for the whole batch', async () => {
    // One of the two items' storage locations is under an active count (first
    // dbRequest.query call to resolve gets the blocked recordset); which item
    // that ends up being isn't guaranteed under Promise.all, so this asserts
    // the batch-level shape rather than a specific index.
    dbRequest.query.mockResolvedValueOnce({
      recordset: [{ CountId: 7, CountType: 'PRODUCTION', Status: 'PendingApproval' }],
    });
    axiosMock.post.mockResolvedValue({
      data: { success: true, data: { success: true, transferOrderNumber: '4500002222', messages: [] } },
    });

    const res = await request(appLogSuper)
      .post('/warehouse/batch-cleanup-transfer-bulk')
      .send({
        items: [
          { kind: 'transfer', payload: { Material: '30005R', StorageLocation: '1716' } },
          { kind: 'transfer', payload: { Material: '30006R', StorageLocation: '1717' } },
        ],
      });

    expect(res.status).toBe(200);
    const successes = res.body.results.filter(r => r.success);
    const failures  = res.body.results.filter(r => !r.success);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });
});

describe('POST /warehouse/create-lt04', () => {
  test('passes StorageLocation to the guard but never forwards it to SapServer', async () => {
    axiosMock.post.mockResolvedValueOnce({ data: { success: true, data: { transferOrderNumber: '4500007777' } } });

    const res = await request(app)
      .post('/warehouse/create-lt04')
      .send({ TrNumber: '123', Material: '30005R', StorageLocation: '1710' });

    expect(res.status).toBe(200);
    const [, sentBody] = axiosMock.post.mock.calls[0];
    expect(sentBody).not.toHaveProperty('StorageLocation');
  });

  test('409s when an active count blocks the given StorageLocation', async () => {
    dbRequest.query.mockResolvedValueOnce({
      recordset: [{ CountId: 9, CountType: 'RAW_MATERIAL', Status: 'Open' }],
    });

    const res = await request(app)
      .post('/warehouse/create-lt04')
      .send({ TrNumber: '123', Material: '30005R', StorageLocation: '1710' });

    expect(res.status).toBe(409);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('skips the guard (does not fail closed) when StorageLocation is omitted', async () => {
    axiosMock.post.mockResolvedValueOnce({ data: { success: true, data: { transferOrderNumber: '4500007778' } } });

    const res = await request(app)
      .post('/warehouse/create-lt04')
      .send({ TrNumber: '123', Material: '30005R' });

    expect(res.status).toBe(200);
    expect(axiosMock.post).toHaveBeenCalled();
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
