// routes/productionschedule.js is a thin wrapper over
// routes/productionschedulesql.js (covered directly in
// test/unit/productionschedulesql.test.js) — this suite covers the
// department/permission gates (view: production OR sales; edit: either
// supervisor permission) and attachComments()'s merge-by-key logic, with
// the DB layer mocked wholesale.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser, productionSupervisor, adminUser } from '../helpers/fixtures/users.js';

const db = {
  getProductionSchedule: jest.fn(),
  getProductionArrears: jest.fn(),
  listProductionScheduleComments: jest.fn(),
  upsertProductionScheduleComment: jest.fn(),
  getOtifKpiHistory: jest.fn(),
  getOtifLateList: jest.fn(),
  diffProductionScheduleOtif: jest.fn(),
};
jest.unstable_mockModule('../../routes/productionschedulesql.js', () => db);

// A sales-department, non-supervisor user — can view but not edit.
const salesUser = { userID: 401, username: 'k.sales', role: 'operator', departments: ['sales'], permissions: [], shortIdleTimeout: false };

let scheduleRouter;
let runProductionScheduleOtifDiff;
let appProduction;
let appSales;
let appSupervisor;
let appNoAccess;

beforeAll(async () => {
  ({ default: scheduleRouter, runProductionScheduleOtifDiff } = await import('../../routes/productionschedule.js'));
  appProduction = buildTestApp(scheduleRouter, { sessionUser: operatorUser }); // department: production
  appSales = buildTestApp(scheduleRouter, { sessionUser: salesUser });
  appSupervisor = buildTestApp(scheduleRouter, { sessionUser: productionSupervisor });
  appNoAccess = buildTestApp(scheduleRouter, { sessionUser: adminUser }); // department: logistics — neither production nor sales
});

beforeEach(() => {
  Object.values(db).forEach(fn => fn.mockReset());
  db.listProductionScheduleComments.mockResolvedValue(new Map());
});

describe('GET / — canView gate and comment merging', () => {
  test('403s for a user in neither production nor sales', async () => {
    // requireAnyDepartment only returns 403 JSON for requests it recognises
    // as API calls (xhr/Accept: application/json) — plain requests get a
    // redirect instead, so set the header to exercise the path the real
    // frontend (fetch) actually takes.
    const res = await request(appNoAccess).get('/').set('Accept', 'application/json');
    expect(res.status).toBe(403);
    expect(db.getProductionSchedule).not.toHaveBeenCalled();
  });

  test('allows the sales department through too', async () => {
    db.getProductionSchedule.mockResolvedValueOnce({ rows: [], windowStart: null, windowEnd: null });
    const res = await request(appSales).get('/');
    expect(res.status).toBe(200);
  });

  test('merges a matching comment/eta onto its row by ReferenceDocument+Item', async () => {
    db.getProductionSchedule.mockResolvedValueOnce({
      rows: [{ ReferenceDocument: 'SO1', Item: '10' }],
      windowStart: '2026-01-09', windowEnd: '2026-01-15',
    });
    db.listProductionScheduleComments.mockResolvedValueOnce(
      new Map([['SO1||10', { comment: 'Rush', eta: '2026-01-10', lastUpdatedUtc: 'x', updatedByUsername: 'a.admin' }]]),
    );
    const res = await request(appProduction).get('/');
    expect(res.body.data[0]).toMatchObject({ comment: 'Rush', eta: '2026-01-10', commentUpdatedBy: 'a.admin' });
  });

  test('rows with no matching comment get blank defaults, not undefined', async () => {
    db.getProductionSchedule.mockResolvedValueOnce({ rows: [{ ReferenceDocument: 'SO2', Item: '20' }], windowStart: null, windowEnd: null });
    const res = await request(appProduction).get('/');
    expect(res.body.data[0]).toMatchObject({ comment: '', eta: null, commentUpdatedBy: '' });
  });

  test('a DB failure is reported as a 500', async () => {
    db.getProductionSchedule.mockRejectedValueOnce(new Error('boom'));
    const res = await request(appProduction).get('/');
    expect(res.status).toBe(500);
  });
});

describe('GET /arrears', () => {
  test('403s outside production/sales', async () => {
    const res = await request(appNoAccess).get('/arrears').set('Accept', 'application/json');
    expect(res.status).toBe(403);
  });

  test('merges comments the same way as GET /', async () => {
    db.getProductionArrears.mockResolvedValueOnce([{ ReferenceDocument: 'SO3', Item: '30' }]);
    const res = await request(appProduction).get('/arrears');
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ ReferenceDocument: 'SO3', comment: '' });
  });
});

describe('PUT /:referenceDocument/:item — canEdit gate', () => {
  test('403s a plain operator (no supervisor permission)', async () => {
    const res = await request(appProduction).put('/SO1/10').send({ comment: 'x' });
    expect(res.status).toBe(403);
    expect(db.upsertProductionScheduleComment).not.toHaveBeenCalled();
  });

  test('a production supervisor can save', async () => {
    const res = await request(appSupervisor).put('/SO1/10').send({ comment: 'Rush', eta: '2026-01-10' });
    expect(res.status).toBe(200);
    expect(db.upsertProductionScheduleComment).toHaveBeenCalledWith(
      { referenceDocument: 'SO1', item: '10', comment: 'Rush', eta: '2026-01-10' },
      productionSupervisor.username,
    );
  });
});

describe('GET /kpi', () => {
  test('computes onTimePct, guarding the divide-by-zero month', async () => {
    db.getOtifKpiHistory.mockResolvedValueOnce([
      { Year: 2026, Month: 1, OnTimeCount: 8, TotalCount: 10 },
      { Year: 2026, Month: 2, OnTimeCount: 0, TotalCount: 0 },
    ]);
    const res = await request(appProduction).get('/kpi');
    expect(res.body.data[0].onTimePct).toBe(80);
    expect(res.body.data[1].onTimePct).toBeNull();
  });
});

describe('GET /kpi/late', () => {
  test('returns the drill-down list', async () => {
    db.getOtifLateList.mockResolvedValueOnce([{ ReferenceDocument: 'SO1' }]);
    const res = await request(appProduction).get('/kpi/late');
    expect(res.body.data).toEqual([{ ReferenceDocument: 'SO1' }]);
  });
});

describe('runProductionScheduleOtifDiff (cron export)', () => {
  test('delegates to db.diffProductionScheduleOtif', async () => {
    db.diffProductionScheduleOtif.mockResolvedValueOnce({ inserted: 1, refreshed: 2, completed: 3 });
    const result = await runProductionScheduleOtifDiff();
    expect(result).toEqual({ inserted: 1, refreshed: 2, completed: 3 });
  });
});
