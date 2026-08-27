// routes/productionnexus.js's POST /drumming/entry (the wizard's direct
// ZF40N backflush path) and GET /process/DR/bom-preview — flagged in
// CLAUDE.md as uncovered. Same axios-mocking setup as
// productionnexus.mixing.test.js (separate file for the same reason: this
// file's beforeAll needs axios mocked, which productionnexus.test.js's
// doesn't set up).
//
// GET /process/DR/bom-preview replaces the old POST /drumming/bom (removed
// — dead code from the UI's perspective, with a stale response shape that
// never matched the real BomRow fields used everywhere else in this file).
//
// Not covered here (documented gap, see CLAUDE.md): POST /drumming/stock
// and POST /drumming/customer (submitDrumming()'s Make-to-Stock/Make-to-
// Order paths) — a materially different, larger SAP call
// (drumming-backflush combining ZF40N + Z_ZPRODBATCH_MAINT + a BOM-vs-
// traceability check) than the wizard's direct backflush tested here, and
// the scrap-entry/additional-operator/parent-batch-trace-link branches
// within /drumming/entry itself.

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

function mockProfitCentreOk() {
  axiosMock.request.mockResolvedValueOnce({ data: { success: true, data: '0000002004' } }); // DR's allowed centre is '2004'
}

const validBody = { material: '30005R', coilLengths: [50] };

describe('GET /process/DR/bom-preview', () => {
  test('400s without material', async () => {
    const res = await request(app).get('/process/DR/bom-preview');
    expect(res.status).toBe(400);
  });

  test('400s for a process code outside the BOM checklist (EX/MX untouched)', async () => {
    const res = await request(app).get('/process/EX/bom-preview?material=30005R');
    expect(res.status).toBe(400);
  });

  test('returns the live BOM component list, enriched with each component\'s profit centre / raw-material flag', async () => {
    axiosMock.request
      .mockResolvedValueOnce({ data: { success: true, data: [
        { material: '30005R', plant: '3012', component: 'M1', item: '0010', componentQty: 1, componentUnit: 'KG', storageLocation: '1710', supplyArea: '312' },
      ] } })
      .mockResolvedValueOnce({ data: { success: true, data: [
        { material: 'M1', profitCentre: '0000002012' }, // raw material
      ] } });
    const res = await request(app).get('/process/DR/bom-preview?material=30005R');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { material: '30005R', plant: '3012', component: 'M1', item: '0010', componentQty: 1, componentUnit: 'KG', storageLocation: '1710', supplyArea: '312', profitCentre: '2012', isRawMaterial: true },
    ]);
  });

  test('502s with a clear message on a SAP failure', async () => {
    axiosMock.request.mockRejectedValueOnce(new Error('RFC timeout'));
    const res = await request(app).get('/process/DR/bom-preview?material=30005R');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/BOM lookup failed/);
  });
});

describe('POST /drumming/entry — validation', () => {
  test('400s without material or coilLengths', async () => {
    const res = await request(app).post('/drumming/entry').send({ coilLengths: [] });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });
});

describe('POST /drumming/entry — parent-batch reversal guard', () => {
  test('409s naming the unreversed parent drum', async () => {
    queueResults({ recordset: [{ IsReversed: false }] });
    const res = await request(app).post('/drumming/entry').send({
      ...validBody, parentBatches: [{ processCode: 'DR', recordID: 5 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/DR00000005/);
    expect(axiosMock.request).not.toHaveBeenCalled(); // never reached the profit-centre check
  });
});

describe('POST /drumming/entry — profit centre check', () => {
  test('400s when the material belongs to a different profit centre', async () => {
    axiosMock.request.mockResolvedValueOnce({ data: { success: true, data: '0000009999' } });
    const res = await request(app).post('/drumming/entry').send(validBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not valid for DR/);
  });
});

describe('POST /drumming/entry — happy path', () => {
  test('creates the Drumming record, backflushes to SAP, and returns 201 COMPLETE', async () => {
    mockProfitCentreOk();
    queueResults(
      { recordset: [{ DrummingID: 10 }] }, // insert Drumming
      { recordset: [] },                   // insert DrummingCoils
      { recordset: [] },                   // insert BatchOperators (primary)
      { recordset: [] },                   // writeEvent STARTED
      { recordset: [] },                   // audit SAP_OK
      { recordset: [] },                   // insert SAPPostings
      { recordset: [] },                   // writeEvent SAP_POST
    );
    axiosMock.post
      .mockResolvedValueOnce({ data: { success: true, data: { type: 'S', messageClass: 'RM', messageNumber: '191', documentNumber: 'MD200', message: 'ok' } } });

    const res = await request(app).post('/drumming/entry').send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ drummingID: 10, materialDocument: 'MD200', status: 'COMPLETE' });
  });

  test('flags a 190 (no component consumption) with a warning', async () => {
    mockProfitCentreOk();
    queueResults(
      { recordset: [{ DrummingID: 11 }] },
      { recordset: [] },
      { recordset: [] },
      { recordset: [] },
      { recordset: [] }, // audit SAP_OK
      { recordset: [] }, // logBackflushAlert
      { recordset: [] }, // writeEvent NOTE
      { recordset: [] }, // insert SAPPostings
      { recordset: [] }, // writeEvent SAP_POST
    );
    axiosMock.post
      .mockResolvedValueOnce({ data: { success: true, data: { type: 'S', messageClass: 'RM', messageNumber: '190', documentNumber: 'MD201', message: 'No components' } } })
      .mockResolvedValueOnce({ data: { success: true } });

    const res = await request(app).post('/drumming/entry').send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.data.warning).toMatch(/SAP 190/);
  });
});

describe('POST /drumming/entry — SAP backflush failure', () => {
  test('marks the record SAP_FAILED but still saves it and responds 201', async () => {
    mockProfitCentreOk();
    queueResults(
      { recordset: [{ DrummingID: 12 }] },
      { recordset: [] },
      { recordset: [] },
      { recordset: [] }, // writeEvent STARTED
      { recordset: [] }, // UPDATE prod.Drumming SET Status=6
      { recordset: [] }, // audit SAP_ERROR
      { recordset: [] }, // insert SAPPostings (failed)
      { recordset: [] }, // writeEvent SAP_FAIL
    );
    axiosMock.post.mockRejectedValueOnce(new Error('RFC connection lost'));

    const res = await request(app).post('/drumming/entry').send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ drummingID: 12, status: 'SAP_FAILED', error: 'RFC connection lost' });
    expect(res.body.warning).toMatch(/SAP backflush failed/);
  });
});
