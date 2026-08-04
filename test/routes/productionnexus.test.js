// routes/productionnexus.js is the largest route file in the app (4136
// lines, 60+ endpoints covering every production work centre's batch
// lifecycle, scrap, reversal, and SAP posting). This suite covers the
// reference-data reads, the shared processConfig()/batch-lookup pattern
// every process-specific endpoint reuses, one representative write (scrap
// logging), and the PROD_SUPERVISOR permission gate — not an exhaustive
// pass over the whole file. See CLAUDE.md for what's not covered yet
// (mixing/drumming entry, SAP posting/reversal execution, failed-backflush
// retry — the highest-remaining-risk endpoints).

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser, productionSupervisor } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let nexusRouter;
let app;
let appSupervisor;

beforeAll(async () => {
  ({ default: nexusRouter } = await import('../../routes/productionnexus.js'));
  app = buildTestApp(nexusRouter, { sessionUser: operatorUser });
  appSupervisor = buildTestApp(nexusRouter, { sessionUser: productionSupervisor });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('reference-data reads (getProductionPool)', () => {
  test('GET /shifts', async () => {
    queueResults({ recordset: [{ ShiftID: 1, ShiftName: 'Days' }] });
    const res = await request(app).get('/shifts');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ ShiftID: 1, ShiftName: 'Days' }]);
  });

  test('GET /work-centres', async () => {
    queueResults({ recordset: [{ WorkCentreID: 1, ProcessCode: 'MX' }] });
    const res = await request(app).get('/work-centres');
    expect(res.status).toBe(200);
  });

  test('GET /scrap-reasons', async () => {
    queueResults({ recordset: [{ ReasonID: 1, ReasonCode: 'CONTAM' }] });
    const res = await request(app).get('/scrap-reasons?pc=MX');
    expect(res.status).toBe(200);
  });

  test('GET /active', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).get('/active');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('GET /batch/:processCode/:recordId', () => {
  test('400s on an unknown process code', async () => {
    const res = await request(app).get('/batch/ZZ/1');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown process code/);
  });

  test('404s when the batch does not exist', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).get('/batch/MX/999');
    expect(res.status).toBe(404);
  });

  test('returns the batch with its operators', async () => {
    queueResults(
      { recordset: [{ MixingID: 1, MixRef: 'MX-00000001' }] },
      { recordset: [{ BatchOperatorID: 1, UserID: 101, Username: 'j.smith', IsPrimary: true }] },
    );
    const res = await request(app).get('/batch/MX/1');
    expect(res.status).toBe(200);
    expect(res.body.data.batch.MixRef).toBe('MX-00000001');
    expect(res.body.data.operators).toHaveLength(1);
  });
});

describe('POST /scrap', () => {
  test('requires all fields', async () => {
    const res = await request(app).post('/scrap').send({ processCode: 'MX' });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('400s on an unknown process code', async () => {
    const res = await request(app).post('/scrap').send({
      processCode: 'ZZ', processRecordID: 1, reasonID: 1, quantity: 5, unitOfMeasure: 'KG',
    });
    expect(res.status).toBe(400);
  });

  test('logs scrap and notifies supervisors', async () => {
    queueResults(
      { recordset: [] }, // INSERT INTO ScrapEntries
      { recordset: [] }, // writeEvent
      { recordset: [] }, // notify() fire-and-forget insert
    );
    const res = await request(app).post('/scrap').send({
      processCode: 'mx', processRecordID: 1, reasonID: 2, quantity: 5.5, unitOfMeasure: 'KG',
    });
    expect(res.status).toBe(201);
  });
});

describe('permission-gated endpoints (PROD_SUPERVISOR)', () => {
  test('GET /open-runs is rejected for a plain operator', async () => {
    const res = await request(app).get('/open-runs');
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('GET /open-runs is allowed for a supervisor', async () => {
    queueResults({ recordset: [] });
    const res = await request(appSupervisor).get('/open-runs');
    expect(res.status).toBe(200);
  });

  test('POST /reversal/execute is rejected for a plain operator', async () => {
    const res = await request(app).post('/reversal/execute').send({});
    expect(res.status).toBe(403);
  });
});
