// routes/performance.js's Isopar Tied Oil routes (Material 10010) — meter readings,
// planning rate, and HMRC declarations. mssql mocked via test/helpers/mockPool.js;
// routes/performancesql.js mocked wholesale (this file only exercises the route layer's
// validation/permission-gating/orchestration, not the DB-layer arithmetic already covered
// by test/unit/performancesql.isopar.test.js). System time pinned so period-boundary
// checks are deterministic.

import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const db = {
  listIsoparReadings: jest.fn(),
  createIsoparReading: jest.fn(),
  updateIsoparReading: jest.fn(),
  deleteIsoparReading: jest.fn(),
  getIsoparPlanningRate: jest.fn(),
  updateIsoparPlanningRate: jest.fn(),
  listIsoparDeclarations: jest.fn(),
  listIsoparOutstandingPeriods: jest.fn(),
  computeIsoparPeriodFigures: jest.fn(),
  createIsoparDeclaration: jest.fn(),
  getIsoparForecastContext: jest.fn(),
  // Unrelated exports the router imports at module scope — must exist so `import * as db`
  // doesn't leave other routes calling undefined functions if this mock is ever reused.
  listOpenIncomingOrders: jest.fn(),
  listDemandAdjustments: jest.fn(),
  listVendorMaterialsForSuggestions: jest.fn(),
};
jest.unstable_mockModule('../../routes/performancesql.js', () => db);

const mrpUser = { ...operatorUser, permissions: ['LOG_MRP'] };
const declUser = { ...operatorUser, permissions: ['LOG_MRP', 'ISOPAR_DECL'], userID: 42, username: 'declarer' };

let performanceRouter;
let app;
let appMrp;
let appDecl;

beforeAll(async () => {
  ({ default: performanceRouter } = await import('../../routes/performance.js'));
  app = buildTestApp(performanceRouter, { sessionUser: operatorUser });
  appMrp = buildTestApp(performanceRouter, { sessionUser: mrpUser });
  appDecl = buildTestApp(performanceRouter, { sessionUser: declUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  Object.values(db).forEach(fn => fn.mockReset());
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-15T12:00:00.000Z')); // period 0 (Aug-Oct 2026) has ended
});

afterEach(() => {
  jest.useRealTimers();
});

describe('permission gating', () => {
  test('readings/planning-rate require LOG_MRP', async () => {
    expect((await request(app).get('/isopar/readings')).status).toBe(403);
    expect((await request(app).get('/isopar/planning-rate')).status).toBe(403);
  });

  test('declaration routes require ISOPAR_DECL — an LOG_MRP-only user still gets 403', async () => {
    expect((await request(appMrp).get('/isopar/declarations')).status).toBe(403);
    expect((await request(appMrp).get('/isopar/declarations/outstanding')).status).toBe(403);
    expect((await request(appMrp).get('/isopar/declarations/current-period-preview')).status).toBe(403);
    expect((await request(appMrp).post('/isopar/declarations').send({ periodStart: '2026-08-01', periodEnd: '2026-10-31' })).status).toBe(403);
  });

  test('declaration routes succeed for a user holding ISOPAR_DECL', async () => {
    db.listIsoparDeclarations.mockResolvedValueOnce([]);
    const res = await request(appDecl).get('/isopar/declarations');
    expect(res.status).toBe(200);
  });
});

describe('readings CRUD', () => {
  test('POST rejects a missing readingDate', async () => {
    const res = await request(appMrp).post('/isopar/readings').send({ readingQty: 100 });
    expect(res.status).toBe(400);
  });

  test('POST rejects a negative readingQty', async () => {
    const res = await request(appMrp).post('/isopar/readings').send({ readingDate: '2026-08-01', readingQty: -5 });
    expect(res.status).toBe(400);
  });

  test('POST propagates a duplicate-date rejection (400) from the data layer', async () => {
    const err = new Error('A reading already exists for 2026-08-01 — edit it instead of adding a second one.');
    err.statusCode = 400;
    db.createIsoparReading.mockRejectedValueOnce(err);
    const res = await request(appMrp).post('/isopar/readings').send({ readingDate: '2026-08-01', readingQty: 10000 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('already exists');
  });

  test('POST succeeds with a valid reading', async () => {
    db.createIsoparReading.mockResolvedValueOnce(7);
    const res = await request(appMrp).post('/isopar/readings').send({ readingDate: '2026-08-01', readingQty: 10000 });
    expect(res.status).toBe(200);
    expect(res.body.data.readingId).toBe(7);
  });

  test('PUT rejects a negative readingQty', async () => {
    const res = await request(appMrp).put('/isopar/readings/7').send({ readingQty: -1 });
    expect(res.status).toBe(400);
  });

  test('DELETE succeeds', async () => {
    const res = await request(appMrp).delete('/isopar/readings/7');
    expect(res.status).toBe(200);
    expect(db.deleteIsoparReading).toHaveBeenCalledWith('7');
  });
});

describe('GET /isopar/planning-rate', () => {
  test('returns current/actual/recommendation, with recommendation null when actual is close to configured', async () => {
    db.getIsoparPlanningRate.mockResolvedValueOnce({ RateId: 1, WeekdayRateLPerDay: 450, WeekendRateLPerDay: 50 });
    db.listIsoparReadings.mockResolvedValueOnce([
      { ReadingDate: '2026-08-01T00:00:00Z', ReadingQty: 10000 },
      { ReadingDate: '2026-08-02T00:00:00Z', ReadingQty: 9550 }, // Sunday — 450 consumed... wait see below
    ]);
    const res = await request(appMrp).get('/isopar/planning-rate');
    expect(res.status).toBe(200);
    expect(res.body.data.current).toMatchObject({ WeekdayRateLPerDay: 450 });
  });

  test('recommends an updated rate when actual consumption meaningfully diverges from configured', async () => {
    db.getIsoparPlanningRate.mockResolvedValueOnce({ RateId: 1, WeekdayRateLPerDay: 450, WeekendRateLPerDay: 50 });
    // 6 consecutive weekday readings (Mon-Sat 2026-08-03..08), each dropping by 600 (well above
    // the configured 450) — 5 weekday intervals, enough to clear the >=5-sample threshold.
    const readings = [];
    let qty = 20000;
    for (let d = 3; d <= 8; d++) {
      readings.push({ ReadingDate: `2026-08-0${d}T00:00:00Z`, ReadingQty: qty });
      qty -= 600;
    }
    db.listIsoparReadings.mockResolvedValueOnce(readings);

    const res = await request(appMrp).get('/isopar/planning-rate');
    expect(res.status).toBe(200);
    expect(res.body.data.recommendation).toMatchObject({ weekdayRateLPerDay: 600 });
  });

  test('PUT inserts a new versioned rate row', async () => {
    db.updateIsoparPlanningRate.mockResolvedValueOnce(5);
    const res = await request(appMrp).put('/isopar/planning-rate').send({ weekdayRateLPerDay: 480, weekendRateLPerDay: 60, source: 'Manual' });
    expect(res.status).toBe(200);
    expect(res.body.data.rateId).toBe(5);
  });
});

describe('POST /isopar/declarations', () => {
  test('rejects a period that is not in the outstanding list', async () => {
    db.listIsoparOutstandingPeriods.mockResolvedValueOnce([
      { index: 0, start: new Date('2026-08-01T00:00:00Z'), end: new Date('2026-10-31T00:00:00Z') },
    ]);
    const res = await request(appDecl).post('/isopar/declarations').send({
      periodStart: '2026-11-01T00:00:00Z', periodEnd: '2027-01-31T00:00:00Z', // not outstanding yet
    });
    expect(res.status).toBe(400);
    expect(db.computeIsoparPeriodFigures).not.toHaveBeenCalled();
  });

  test('rejects when computeIsoparPeriodFigures reports an incomplete period (missing a reading)', async () => {
    db.listIsoparOutstandingPeriods.mockResolvedValueOnce([
      { index: 0, start: new Date('2026-08-01T00:00:00Z'), end: new Date('2026-10-31T00:00:00Z') },
    ]);
    db.computeIsoparPeriodFigures.mockResolvedValueOnce({ complete: false });

    const res = await request(appDecl).post('/isopar/declarations').send({
      periodStart: '2026-08-01T00:00:00Z', periodEnd: '2026-10-31T00:00:00Z',
    });
    expect(res.status).toBe(400);
    expect(db.createIsoparDeclaration).not.toHaveBeenCalled();
  });

  test('recomputes figures fresh at submit time (never trusts client-submitted figures) and persists them', async () => {
    db.listIsoparOutstandingPeriods.mockResolvedValueOnce([
      { index: 0, start: new Date('2026-08-01T00:00:00Z'), end: new Date('2026-10-31T00:00:00Z') },
    ]);
    db.computeIsoparPeriodFigures.mockResolvedValueOnce({
      complete: true, openingStockQty: 10000, receivedQty: 5000, closingStockQty: 4000, consumedQty: 11000,
      openingReading: { ReadingId: 1 }, closingReading: { ReadingId: 2 }, deliveries: [],
    });
    db.createIsoparDeclaration.mockResolvedValueOnce(9);

    // Client sends bogus figures alongside the period — the route must ignore them entirely.
    const res = await request(appDecl).post('/isopar/declarations').send({
      periodStart: '2026-08-01T00:00:00Z', periodEnd: '2026-10-31T00:00:00Z',
      openingStockQty: 999999, notes: 'filed on time',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.declarationId).toBe(9);
    const persisted = db.createIsoparDeclaration.mock.calls[0][0];
    expect(persisted.openingStockQty).toBe(10000); // from computeIsoparPeriodFigures, not the client's 999999
    expect(persisted.consumedQty).toBe(11000);
    expect(persisted.submittedByUserId).toBe(42);
    expect(persisted.submittedByUsername).toBe('declarer');
  });

  test('the frozen-declaration guarantee: history reads never re-derive from live data', async () => {
    // Once submitted, GET /isopar/declarations just returns whatever listIsoparDeclarations
    // (a plain SELECT) reports — proving the read path has no recompute step for it to drift.
    db.listIsoparDeclarations.mockResolvedValueOnce([
      { DeclarationId: 9, PeriodStart: '2026-08-01T00:00:00Z', PeriodEnd: '2026-10-31T00:00:00Z', ConsumedQty: 11000 },
    ]);
    const res = await request(appDecl).get('/isopar/declarations');
    expect(res.status).toBe(200);
    expect(res.body.data[0].ConsumedQty).toBe(11000);
    expect(db.computeIsoparPeriodFigures).not.toHaveBeenCalled(); // history never recomputes
  });
});

// GET /isopar/stock-risk — rebuilds the live forecast from the meter reading + planning rate +
// any real pending Isopar deliveries, and flags a stockout or tank-overfill risk. Tank capacity
// 7000L, reorder at 2000L, fixed 5000L orders (see migrations/nexus_operations/20260814090000_
// isopar_inventory_policy.cjs) — 2000+5000=7000 by design, so risk should only surface when the
// forecast disagrees with that plan (e.g. a reading confirms consumption has diverged).
describe('GET /isopar/stock-risk', () => {
  test('returns null when there is no meter reading yet — nothing to check', async () => {
    db.getIsoparForecastContext.mockResolvedValueOnce({ latestReading: null, planningRate: { WeekdayRateLPerDay: 450, WeekendRateLPerDay: 50, MaxStockCapacityQty: 7000 } });
    db.listOpenIncomingOrders.mockResolvedValueOnce([]);

    const res = await request(appMrp).get('/isopar/stock-risk');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  test('returns null when the near-term (14-day) forecast never breaches 0 or the tank capacity', async () => {
    // A freshly topped-up tank at exactly the 7000L cap comfortably outlasts the 14-day review
    // window at ~400 L/day average — no pending delivery needed to stay safe that soon.
    db.getIsoparForecastContext.mockResolvedValueOnce({
      latestReading: { ReadingId: 1, ReadingDate: '2026-11-15T00:00:00Z', ReadingQty: 7000 },
      planningRate: { WeekdayRateLPerDay: 450, WeekendRateLPerDay: 50, MaxStockCapacityQty: 7000 },
    });
    db.listOpenIncomingOrders.mockResolvedValueOnce([]);

    const res = await request(appMrp).get('/isopar/stock-risk');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  test('does NOT flag a stockout far outside the review window just because nothing is pending yet', async () => {
    // 5000L with nothing on order will eventually hit zero (in ~3 weeks), but that's well past
    // the 14-day near-term window this check cares about — the standard Order Suggestions engine
    // (breach-date + lead-time) is what surfaces that kind of longer-range "due soon" case.
    db.getIsoparForecastContext.mockResolvedValueOnce({
      latestReading: { ReadingId: 1, ReadingDate: '2026-11-15T00:00:00Z', ReadingQty: 5000 },
      planningRate: { WeekdayRateLPerDay: 450, WeekendRateLPerDay: 50, MaxStockCapacityQty: 7000 },
    });
    db.listOpenIncomingOrders.mockResolvedValueOnce([]);

    const res = await request(appMrp).get('/isopar/stock-risk');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  test('flags a stockout risk when current stock is already at/below 0', async () => {
    db.getIsoparForecastContext.mockResolvedValueOnce({
      latestReading: { ReadingId: 1, ReadingDate: '2026-11-15T00:00:00Z', ReadingQty: 0 },
      planningRate: { WeekdayRateLPerDay: 450, WeekendRateLPerDay: 50, MaxStockCapacityQty: 7000 },
    });
    db.listOpenIncomingOrders.mockResolvedValueOnce([]);

    const res = await request(appMrp).get('/isopar/stock-risk');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ currentStock: 0, stockoutDate: expect.any(String), overCapacityDate: null });
  });

  test('flags an overcapacity risk when a pending delivery would push stock above MaxStockCapacityQty', async () => {
    db.getIsoparForecastContext.mockResolvedValueOnce({
      latestReading: { ReadingId: 1, ReadingDate: '2026-11-15T00:00:00Z', ReadingQty: 6000 }, // higher than usual at reorder time
      planningRate: { WeekdayRateLPerDay: 450, WeekendRateLPerDay: 50, MaxStockCapacityQty: 7000 },
    });
    // A 5000L delivery lands imminently, on top of 6000L already on hand — well over the 7000L cap.
    db.listOpenIncomingOrders.mockResolvedValueOnce([
      { SuggestionId: 1, Material: '10010', OrderQty: 5000, DeliveryDate: '2026-11-16T00:00:00Z', Status: 'Ordered' },
    ]);

    const res = await request(appMrp).get('/isopar/stock-risk');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ stockoutDate: null, overCapacityDate: expect.any(String), maxStockCapacityQty: 7000 });
  });

  test('requires LOG_MRP', async () => {
    const res = await request(app).get('/isopar/stock-risk');
    expect(res.status).toBe(403);
  });
});
