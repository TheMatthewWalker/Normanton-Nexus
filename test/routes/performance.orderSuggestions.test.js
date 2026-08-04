// routes/performance.js's GET /order-suggestions (MRP Phase 2b) — flagged
// in CLAUDE.md as the largest uncovered chunk of this file. Its real logic
// (buildSuggestionForRow/buildWeeklyStockForecast/findStockBelowThresholdDate/
// demandOverDays/groupSuggestionsByVendor) is entirely un-exported, so it's
// exercised here through the HTTP route with routes/performancesql.js (db)
// mocked. System time is pinned via fake timers to a fixed Wednesday-
// adjacent Thursday (2026-01-15, noon UTC) so the 13-month forecast horizon
// and working-day lead-time math are deterministic; the expected numbers
// below were independently hand-computed (see conversation/session notes)
// against the same day-by-day forecast algorithm the route uses.
//
// Scenario: two materials on the same vendor, both driven by a flat 100/day
// January usage rate (PredictedM12=3100 over Jan's 31 days) starting from
// 500 units on hand against a 100-unit safety floor — one with a 3-working-
// day lead time (breaches before today = Overdue), one with a 1-working-day
// lead time (breaches within the 14-day review horizon but not yet = DueSoon).
// A third material on a different vendor never breaches within the 13-month
// horizon at all and must be silently excluded rather than appearing with a
// null/zero suggestion.

import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const db = {
  listVendorMaterialsForSuggestions: jest.fn(),
  listOpenIncomingOrders: jest.fn(),
  listDemandAdjustments: jest.fn(),
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
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

// Shared shape — only current-month (PredictedM12) usage is nonzero, so the
// breach always happens inside January regardless of the other 12 months'
// (irrelevant, zeroed) values.
function materialRow(overrides) {
  return {
    VendorMaterialId: 1, VendorId: 1, VendorName: 'Chemours',
    Material: 'M1', MaterialText: 'Widget', Uom: 'KG', MrpController: 'X1',
    StockQty: 500, ConsignmentQty: 0,
    PredictedM12: 3100, PredictedM11: 0, PredictedM10: 0, PredictedM09: 0, PredictedM08: 0, PredictedM07: 0,
    PredictedM06: 0, PredictedM05: 0, PredictedM04: 0, PredictedM03: 0, PredictedM02: 0, PredictedM01: 0, PredictedM00: 0,
    MinSafetyStockQty: 100, SapSafetyStock: null,
    LeadTimeDaysOverride: 3, SapLeadTimeDays: null, DefaultLeadTimeDays: null,
    MaterialMoqQty: 0, MaterialMaxQty: 0,
    OrderMoqQty: null, OrderMaxQty: null, OrderMoqUom: 'KG',
    Incoterms: null, ScheduleAgreement: 'SA1', TransitTimeDays: null,
    ...overrides,
  };
}

test('403s without LOG_MRP', async () => {
  const res = await request(app).get('/order-suggestions');
  expect(res.status).toBe(403);
});

test('a material that never breaches within the forecast horizon is excluded entirely', async () => {
  db.listVendorMaterialsForSuggestions.mockResolvedValueOnce([
    materialRow({ VendorId: 2, VendorName: 'Fothergill', Material: 'M3', StockQty: 100000, PredictedM12: 0 }),
  ]);
  const res = await request(appMrp).get('/order-suggestions');
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual([]);
});

test('flags an overdue material with its computed suggested quantity, breach date, and order-by date', async () => {
  db.listVendorMaterialsForSuggestions.mockResolvedValueOnce([materialRow({ LeadTimeDaysOverride: 3 })]);
  const res = await request(appMrp).get('/order-suggestions');

  expect(res.status).toBe(200);
  const material = res.body.data[0].materials[0];
  expect(material).toMatchObject({
    material: 'M1',
    urgency: 'Overdue',
    dueNow: true,
    breachDate: '2026-01-19',
    orderByDate: '2026-01-14',
    suggestedQty: 1300,
    currentStock: 500,
  });
});

test('flags a not-yet-overdue material within the 14-day review horizon as DueSoon', async () => {
  db.listVendorMaterialsForSuggestions.mockResolvedValueOnce([materialRow({ VendorMaterialId: 2, Material: 'M2', LeadTimeDaysOverride: 1 })]);
  const res = await request(appMrp).get('/order-suggestions');

  const material = res.body.data[0].materials[0];
  expect(material).toMatchObject({ material: 'M2', urgency: 'DueSoon', dueNow: true, orderByDate: '2026-01-16', suggestedQty: 1300 });
});

test('rounds a due suggestion up to the next whole MOQ lot, and caps it at MaterialMaxQty', async () => {
  db.listVendorMaterialsForSuggestions.mockResolvedValueOnce([
    materialRow({ LeadTimeDaysOverride: 3, MaterialMoqQty: 1000, MaterialMaxQty: 0 }), // no cap: ceil(1300/1000)*1000 = 2000
  ]);
  const res1 = await request(appMrp).get('/order-suggestions');
  expect(res1.body.data[0].materials[0].suggestedQty).toBe(2000);

  db.listVendorMaterialsForSuggestions.mockResolvedValueOnce([
    materialRow({ LeadTimeDaysOverride: 3, MaterialMoqQty: 1000, MaterialMaxQty: 1500 }), // capped: floor(1500/1000)*1000 = 1000
  ]);
  const res2 = await request(appMrp).get('/order-suggestions');
  expect(res2.body.data[0].materials[0].suggestedQty).toBe(1000);
});

test('groups same-vendor materials together, sorted by orderByDate, with a combined-order MOQ check', async () => {
  db.listVendorMaterialsForSuggestions.mockResolvedValueOnce([
    materialRow({ VendorMaterialId: 1, Material: 'M1', LeadTimeDaysOverride: 3, MaterialMoqQty: 1000, OrderMoqQty: 3000 }), // Overdue, suggestedQty 2000, orderByDate Jan14
    materialRow({ VendorMaterialId: 2, Material: 'M2', LeadTimeDaysOverride: 1, OrderMoqQty: 3000 }),                       // DueSoon, suggestedQty 1300, orderByDate Jan16
  ]);
  const res = await request(appMrp).get('/order-suggestions');

  expect(res.body.data).toHaveLength(1); // one vendor group
  const group = res.body.data[0];
  expect(group.materials.map(m => m.material)).toEqual(['M1', 'M2']); // sorted by orderByDate ascending
  expect(group.combinedQty).toBe(3300); // 2000 + 1300
  expect(group.earliestOrderByDate).toBe('2026-01-14');
  expect(group.moqMet).toBe(true); // 3300 >= the vendor's 3000 combined MOQ
});

test('a DB failure is reported as a 500', async () => {
  db.listVendorMaterialsForSuggestions.mockRejectedValueOnce(new Error('connection lost'));
  const res = await request(appMrp).get('/order-suggestions');
  expect(res.status).toBe(500);
});
