// routes/palletmain.js — the two pieces of real logic worth testing
// precisely: PATCH /:palletId's SAP-staging-reversal-before-delete guard
// (same pattern as deliverymain.js's cancelHeldPicksheet, but inline here)
// and its dynamic partial-update SET clause, plus /landing-sparkline's
// week-over-week percentage-change calculation (including the prevWeek=0
// edge case, which would otherwise divide by zero).

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const reverseStagedPackageMock = jest.fn();
jest.unstable_mockModule('../../routes/sapStaging.js', () => ({
  reverseStagedPackage: reverseStagedPackageMock,
}));

let palletRouter;
let app;

beforeAll(async () => {
  ({ default: palletRouter } = await import('../../routes/palletmain.js'));
  app = buildTestApp(palletRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  reverseStagedPackageMock.mockReset();
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('PATCH /:palletId', () => {
  test('400s when there is nothing to update', async () => {
    const res = await request(app).patch('/1').send({});
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('only sets the fields actually provided', async () => {
    queueResults({ recordset: [] });
    await request(app).patch('/1').send({ palletLocation: 'BIN-5' });
    const sql = dbRequest.query.mock.calls[0][0];
    expect(sql).toContain('palletLocation = @palletLocation');
    expect(sql).not.toContain('grossWeight');
  });

  test('setting palletFinish also stamps palletFinishDate', async () => {
    queueResults({ recordset: [] });
    await request(app).patch('/1').send({ palletFinish: true });
    const sql = dbRequest.query.mock.calls[0][0];
    expect(sql).toContain('palletFinishDate = GETDATE()');
  });

  test('marking a pallet removed reverses every staged package first, and blocks the update on failure', async () => {
    queueResults({ recordset: [{ palletItemID: 1, sapMaterial: '30005R', sapBatch: 'B1' }] });
    reverseStagedPackageMock.mockResolvedValueOnce({ attempted: true, success: false, error: 'SAP session lost' });

    const res = await request(app).patch('/1').send({ palletRemoved: true });

    expect(res.status).toBe(422);
    expect(res.body.failures).toEqual([{ palletItemID: 1, sapMaterial: '30005R', sapBatch: 'B1', error: 'SAP session lost' }]);
    expect(dbRequest.query).toHaveBeenCalledTimes(1); // only the package lookup — no UPDATE
  });

  test('marking a pallet removed proceeds to the UPDATE once every package reverses cleanly', async () => {
    queueResults(
      { recordset: [{ palletItemID: 1, sapMaterial: '30005R', sapBatch: 'B1' }] },
      { recordset: [] }, // the UPDATE
    );
    reverseStagedPackageMock.mockResolvedValueOnce({ attempted: true, success: true });

    const res = await request(app).patch('/1').send({ palletRemoved: true });

    expect(res.status).toBe(200);
    expect(dbRequest.query).toHaveBeenCalledTimes(2);
  });
});

describe('GET /landing-sparkline', () => {
  test('reports 100% growth when last week was zero and this week is not', async () => {
    queueResults(
      { recordset: Array(7).fill({ cnt: 0 }).map((r, i) => ({ day: i, cnt: i === 6 ? 5 : 0 })) },
      { recordset: [{ cnt: 0 }] }, // previous week
      { recordset: [{ cnt: 0 }] }, // overdue
    );
    const res = await request(app).get('/landing-sparkline');
    expect(res.body.data.pctChange).toBe(100);
  });

  test('reports 0% change when both weeks are zero', async () => {
    queueResults(
      { recordset: Array(7).fill({ cnt: 0 }) },
      { recordset: [{ cnt: 0 }] },
      { recordset: [{ cnt: 0 }] },
    );
    const res = await request(app).get('/landing-sparkline');
    expect(res.body.data.pctChange).toBe(0);
    expect(res.body.data.thisWeek).toBe(0);
  });

  test('computes the rounded percentage change for a normal week', async () => {
    queueResults(
      { recordset: [{ cnt: 5 }, { cnt: 5 }, { cnt: 5 }, { cnt: 0 }, { cnt: 0 }, { cnt: 0 }, { cnt: 0 }] }, // thisWeek = 15
      { recordset: [{ cnt: 10 }] }, // prevWeek = 10
      { recordset: [{ cnt: 2 }] },
    );
    const res = await request(app).get('/landing-sparkline');
    expect(res.body.data.thisWeek).toBe(15);
    expect(res.body.data.pctChange).toBe(50); // (15-10)/10 * 100
    expect(res.body.data.overduePicksheets).toBe(2);
  });
});

describe('POST / (create)', () => {
  test('creates a pallet and returns the new ID', async () => {
    queueResults({ recordset: [{ palletID: 7 }] });
    const res = await request(app).post('/').send({ palletType: 'Euro' });
    expect(res.status).toBe(201);
    expect(res.body.palletID).toBe(7);
  });
});
