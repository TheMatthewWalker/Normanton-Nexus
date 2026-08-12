// routes/performance.js's GET /turns-valclass/history — the Stock History &
// Forecast page's backing route. Its real logic (buildWeeklyStockForecast /
// mergeWeeklyForecasts) is entirely un-exported, so it's exercised here
// through the HTTP route with routes/performancesql.js (db) mocked and the
// TurnsValClassSnapshot/ForecastAccuracyLog SQL responses stubbed on the
// shared mocked mssql request. System time is pinned so week boundaries are
// deterministic.
//
// Covers: the 26-week response truncation (the underlying forecast still
// computes a full ~56-week/13-month horizon internally — only the response
// is sliced), and the per-week `deliveries` breakdown plus
// `?excludeDeliveryIds=` what-if filtering added alongside the vendor-filter
// stock graphs.

import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const db = {
  listOpenIncomingOrders: jest.fn(),
  listDemandAdjustments: jest.fn(),
  getIsoparForecastContext: jest.fn(),
};
jest.unstable_mockModule('../../routes/performancesql.js', () => db);

const mrpUser = { ...operatorUser, permissions: ['LOG_MRP'] };

let performanceRouter;
let app;
let appMrp;

beforeAll(async () => {
  ({ default: performanceRouter } = await import('../../routes/performance.js'));
  app = buildTestApp(performanceRouter, { sessionUser: operatorUser });
  appMrp = buildTestApp(performanceRouter, { sessionUser: mrpUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  Object.values(db).forEach(fn => fn.mockReset());
  db.listOpenIncomingOrders.mockResolvedValue([]);
  db.listDemandAdjustments.mockResolvedValue([]);
  db.getIsoparForecastContext.mockResolvedValue({ latestReading: null, planningRate: null });
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

// Only the current month (PredictedM12, array index 0 — see buildWeeklyStockForecast's header
// comment) carries usage, spread flat across January, so week math is easy to reason about.
function snapshotRow(overrides) {
  return {
    Material: 'M1', MaterialText: 'Widget', Plant: '1000', Uom: 'KG',
    StockQty: 10000, ConsignmentQty: 0,
    HistoryM12: 0, HistoryM11: 0, HistoryM10: 0, HistoryM09: 0, HistoryM08: 0, HistoryM07: 0,
    HistoryM06: 0, HistoryM05: 0, HistoryM04: 0, HistoryM03: 0, HistoryM02: 0, HistoryM01: 0, HistoryM00: 0,
    ForecastM12: 0, ForecastM11: 0, ForecastM10: 0, ForecastM09: 0, ForecastM08: 0, ForecastM07: 0,
    ForecastM06: 0, ForecastM05: 0, ForecastM04: 0, ForecastM03: 0, ForecastM02: 0, ForecastM01: 0, ForecastM00: 0,
    PredictedM12: 3100, PredictedM11: 100, PredictedM10: 100, PredictedM09: 100, PredictedM08: 100, PredictedM07: 100,
    PredictedM06: 100, PredictedM05: 100, PredictedM04: 100, PredictedM03: 100, PredictedM02: 100, PredictedM01: 100, PredictedM00: 100,
    ...overrides,
  };
}

function queueSnapshotAndAccuracy(rows) {
  dbRequest.query
    .mockResolvedValueOnce({ recordset: rows })   // TurnsValClassSnapshot
    .mockResolvedValueOnce({ recordset: [] });      // ForecastAccuracyLog
}

test('403s without LOG_MRP', async () => {
  const res = await request(app).get('/turns-valclass/history?materials=M1');
  expect(res.status).toBe(403);
});

test('truncates the weekly stock forecast to 26 weeks even though the underlying horizon is ~13 months', async () => {
  queueSnapshotAndAccuracy([snapshotRow()]);

  const res = await request(appMrp).get('/turns-valclass/history?materials=M1');

  expect(res.status).toBe(200);
  expect(res.body.stockForecast.weeks.length).toBe(26);
});

test('reports a per-week delivery breakdown, which excludeDeliveryIds can filter out as a what-if', async () => {
  // Lands in the first week (2026-01-15 through 2026-01-22).
  db.listOpenIncomingOrders.mockResolvedValue([
    { SuggestionId: 101, Material: 'M1', OrderQty: 500, DeliveryDate: '2026-01-16T00:00:00Z', Status: 'Ordered', PoNumber: 'PO123' },
  ]);
  queueSnapshotAndAccuracy([snapshotRow()]);

  const withDelivery = await request(appMrp).get('/turns-valclass/history?materials=M1');
  expect(withDelivery.status).toBe(200);
  const firstWeek = withDelivery.body.stockForecast.weeks[0];
  expect(firstWeek.deliveries).toEqual([{ id: 101, poNumber: 'PO123', qty: 500 }]);
  expect(firstWeek.incomingQty).toBe(500);

  // Same request, but this delivery is excluded (simulating "what if it's late/lost") — the
  // delivery must disappear from that week and expectedStock must drop by exactly its qty.
  queueSnapshotAndAccuracy([snapshotRow()]);
  const excluded = await request(appMrp).get('/turns-valclass/history?materials=M1&excludeDeliveryIds=101');
  expect(excluded.status).toBe(200);
  const firstWeekExcluded = excluded.body.stockForecast.weeks[0];
  expect(firstWeekExcluded.deliveries).toEqual([]);
  expect(firstWeekExcluded.incomingQty).toBe(0);
  expect(firstWeekExcluded.expectedStock).toBe(firstWeek.expectedStock - 500);
});

// Isopar (Material 10010) is planned off a manual meter reading + fixed weekday/weekend rate
// instead of SAP figures — see the Isopar branch inside the /turns-valclass/history route.
describe('Isopar (Material 10010) override', () => {
  test('uses the meter reading as currentStock, not SAP StockQty, when a reading exists', async () => {
    db.getIsoparForecastContext.mockResolvedValueOnce({
      latestReading: { ReadingId: 1, ReadingDate: '2026-01-15T00:00:00Z', ReadingQty: 5000 },
      planningRate: { WeekdayRateLPerDay: 450, WeekendRateLPerDay: 50 },
    });
    queueSnapshotAndAccuracy([snapshotRow({ Material: '10010', StockQty: 999999, ConsignmentQty: 0 })]);

    const res = await request(appMrp).get('/turns-valclass/history?materials=10010');

    expect(res.status).toBe(200);
    expect(res.body.stockForecast.currentStock).toBe(5000); // the meter reading, not SAP's 999999
    expect(res.body.data[0].isoparMeterReading).toMatchObject({ usingMeterReading: true, readingDate: '2026-01-15' });
  });

  test('falls back to SAP StockQty/ConsignmentQty with a fallbackWarning when no reading exists yet', async () => {
    db.getIsoparForecastContext.mockResolvedValueOnce({ latestReading: null, planningRate: { WeekdayRateLPerDay: 450, WeekendRateLPerDay: 50 } });
    queueSnapshotAndAccuracy([snapshotRow({ Material: '10010', StockQty: 7000, ConsignmentQty: 500 })]);

    const res = await request(appMrp).get('/turns-valclass/history?materials=10010');

    expect(res.status).toBe(200);
    expect(res.body.stockForecast.currentStock).toBe(7500);
    expect(res.body.data[0].isoparMeterReading).toMatchObject({ usingMeterReading: false });
    expect(res.body.data[0].isoparMeterReading.fallbackWarning).toEqual(expect.stringContaining('No Isopar meter reading'));
  });
});
