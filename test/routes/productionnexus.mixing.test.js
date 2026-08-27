// routes/productionnexus.js's POST /mixing/entry — flagged in CLAUDE.md as
// one of the highest-remaining-risk uncovered endpoints (per-tub SAP
// backflush posting, partial-failure handling). Separate test file from
// productionnexus.test.js since this endpoint needs axios mocked too (the
// profit-centre check and per-tub SAP backflush calls), which that
// file doesn't set up. lib/notify.js is left unmocked — its fire-and-forget
// failure-notification insert runs for real against the same mocked mssql
// pool, harmlessly, since asserting on an unawaited call would be racy.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const axiosMock = { request: jest.fn(), post: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

let nexusRouter;
let app;

beforeAll(async () => {
  ({ default: nexusRouter } = await import('../../routes/productionnexus.js'));
  app = buildTestApp(nexusRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  axiosMock.request.mockReset();
  axiosMock.post.mockReset();
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

const validBody = {
  mixCode: '30005R',
  supplierBatchNo: 'SB1',
  supplierTubNo: 'ST1',
  tubs: [{ weightKG: 20 }],
};

function mockProfitCentreOk() {
  axiosMock.request.mockResolvedValueOnce({ data: { success: true, data: '0000002000' } }); // MX's allowed centre is '2000'
}

describe('POST /mixing/entry — validation', () => {
  test('400s without mixCode or tubs', async () => {
    const res = await request(app).post('/mixing/entry').send({ supplierBatchNo: 'SB1', supplierTubNo: 'ST1', tubs: [] });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('400s without a supplier batch/tub number', async () => {
    const res = await request(app).post('/mixing/entry').send({ mixCode: '30005R', tubs: [{ weightKG: 10 }] });
    expect(res.status).toBe(400);
  });

  test.each([0, -1, 38.01, NaN])('400s on an invalid tub weight (%p)', async (weightKG) => {
    const res = await request(app).post('/mixing/entry').send({ ...validBody, tubs: [{ weightKG }] });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('accepts a tub weight right at the 38 KG ceiling', async () => {
    mockProfitCentreOk();
    queueResults(
      { recordset: [] },                    // dup check
      { recordset: [{ MixingID: 1 }] },     // insert Mixing
      { recordset: [] },                    // insert BatchOperators
      { recordset: [] },                    // writeEvent STARTED
      { recordset: [{ TubID: 1 }] },        // insert MixingTubs
      { recordset: [] },                    // audit SAP_OK
      { recordset: [] },                    // update MixingTubs
      { recordset: [] },                    // insert SAPPostings
      { recordset: [] },                    // writeEvent SAP_POST
    );
    axiosMock.post
      .mockResolvedValueOnce({ data: { success: true, data: { type: 'S', messageClass: 'RM', messageNumber: '191', documentNumber: 'MD1', message: 'ok' } } });
    const res = await request(app).post('/mixing/entry').send({ ...validBody, tubs: [{ weightKG: 38 }] });
    expect(res.status).toBe(201);
  });
});

describe('POST /mixing/entry — duplicate supplier batch/tub guard', () => {
  test('409s naming the existing MixRef when the same supplier batch+tub was already used', async () => {
    queueResults({ recordset: [{ MixingID: 5, MixRef: 'MX00000005' }] });
    const res = await request(app).post('/mixing/entry').send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('MX00000005');
    expect(axiosMock.request).not.toHaveBeenCalled(); // never even reached the profit-centre check
  });
});

describe('POST /mixing/entry — profit centre check', () => {
  test('400s when the material belongs to a different profit centre', async () => {
    queueResults({ recordset: [] }); // dup check passes
    axiosMock.request.mockResolvedValueOnce({ data: { success: true, data: '0000009999' } }); // not MX's '2000'
    const res = await request(app).post('/mixing/entry').send(validBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not valid for MX/);
  });

  test('502s with a clear message when the profit-centre check itself fails', async () => {
    queueResults({ recordset: [] });
    axiosMock.request.mockRejectedValueOnce(new Error('SAP timeout'));
    const res = await request(app).post('/mixing/entry').send(validBody);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Unable to verify profit centre/);
  });
});

describe('POST /mixing/entry — happy path', () => {
  test('creates the Mixing record, posts each tub to SAP, and returns 201 COMPLETE', async () => {
    mockProfitCentreOk();
    queueResults(
      { recordset: [] },
      { recordset: [{ MixingID: 42 }] },
      { recordset: [] },
      { recordset: [] },
      { recordset: [{ TubID: 100 }] },
      { recordset: [] },
      { recordset: [] },
      { recordset: [] },
      { recordset: [] },
    );
    axiosMock.post
      .mockResolvedValueOnce({ data: { success: true, data: { type: 'S', messageClass: 'RM', messageNumber: '191', documentNumber: 'MD100', message: 'ok' } } })
      .mockResolvedValueOnce({ data: { success: true } });

    const res = await request(app).post('/mixing/entry').send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ mixingID: 42, batchRef: 'MX00000042', status: 'COMPLETE' });
    expect(res.body.data.tubs[0]).toMatchObject({ success: true, materialDocument: 'MD100' });
    expect(res.body.warning).toBeUndefined();
  });

  test('logs a BackflushAlerts row when SAP returns message 190 (no component consumption)', async () => {
    mockProfitCentreOk();
    queueResults(
      { recordset: [] },
      { recordset: [{ MixingID: 42 }] },
      { recordset: [] },
      { recordset: [] },
      { recordset: [{ TubID: 100 }] },
      { recordset: [] }, // logBackflushAlert INSERT
      { recordset: [] }, // writeEvent NOTE
      { recordset: [] }, // audit SAP_OK
      { recordset: [] }, // update MixingTubs
      { recordset: [] }, // insert SAPPostings
      { recordset: [] }, // writeEvent SAP_POST
    );
    axiosMock.post
      .mockResolvedValueOnce({ data: { success: true, data: { type: 'S', messageClass: 'RM', messageNumber: '190', documentNumber: 'MD100', message: 'No components' } } })
      .mockResolvedValueOnce({ data: { success: true } });

    const res = await request(app).post('/mixing/entry').send(validBody);

    expect(res.status).toBe(201);
    const alertInsert = dbRequest.query.mock.calls.find(c => c[0].includes('BackflushAlerts'));
    expect(alertInsert).toBeDefined();
  });
});

describe('POST /mixing/entry — a tub failing SAP posting', () => {
  test('marks the Mixing record SAP_FAILED, reports a warning, and still responds 201', async () => {
    mockProfitCentreOk();
    queueResults(
      { recordset: [] },
      { recordset: [{ MixingID: 77 }] },
      { recordset: [] },
      { recordset: [] },
      { recordset: [{ TubID: 200 }] },
      { recordset: [] }, // update MixingTubs SAPSuccess=0
      { recordset: [] }, // insert SAPPostings (failed)
      { recordset: [] }, // audit SAP_ERROR
      { recordset: [] }, // writeEvent SAP_FAIL
      { recordset: [] }, // UPDATE prod.Mixing SET Status=6
      { recordset: [] }, // notify()'s own insert (fire-and-forget, real notify.js against the mocked pool)
      { recordset: [] },
    );
    axiosMock.post.mockRejectedValueOnce(new Error('RFC connection lost'));

    const res = await request(app).post('/mixing/entry').send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('SAP_FAILED');
    expect(res.body.data.tubs[0]).toMatchObject({ success: false, error: 'RFC connection lost' });
    expect(res.body.warning).toMatch(/Some tubs failed SAP posting/);
    const statusUpdate = dbRequest.query.mock.calls.find(c => c[0].includes('SET Status=6'));
    expect(statusUpdate).toBeDefined();
  });
});
