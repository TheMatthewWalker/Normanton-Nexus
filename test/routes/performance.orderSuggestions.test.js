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
  getVendorMaterialConstraints: jest.fn(),
  getVendorOrderConstraints: jest.fn(),
  acceptOrderSuggestion: jest.fn(),
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

// POST /order-suggestions/preview — the "Start New Order" builder's live what-if chart. Injects
// a synthetic (unsaved) delivery into buildWeeklyStockForecast alongside real open orders, so
// the modal can show the effect of a draft order before accept-batch is ever called.
describe('POST /order-suggestions/preview', () => {
  test('403s without LOG_MRP', async () => {
    const res = await request(app).post('/order-suggestions/preview').send({
      deliveryDate: '2026-02-01', items: [{ material: 'M1', orderQty: 100 }],
    });
    expect(res.status).toBe(403);
  });

  test('400s without a non-empty items array', async () => {
    const res = await request(appMrp).post('/order-suggestions/preview').send({ deliveryDate: '2026-02-01', items: [] });
    expect(res.status).toBe(400);
  });

  test('400s without a valid deliveryDate', async () => {
    const res = await request(appMrp).post('/order-suggestions/preview').send({ items: [{ material: 'M1', orderQty: 100 }] });
    expect(res.status).toBe(400);
  });

  test('injects the draft delivery into the forecast, landing in the week its date falls in', async () => {
    db.listVendorMaterialsForSuggestions.mockResolvedValueOnce([materialRow()]);
    db.listOpenIncomingOrders.mockResolvedValueOnce([]);
    db.listDemandAdjustments.mockResolvedValueOnce([]);

    const res = await request(appMrp).post('/order-suggestions/preview').send({
      deliveryDate: '2026-01-16', // lands in the first week (system time pinned to 2026-01-15)
      items: [{ material: 'M1', orderQty: 400 }],
    });

    expect(res.status).toBe(200);
    const forecast = res.body.data[0].stockForecast;
    expect(forecast.weeks).toHaveLength(26); // same 26-week horizon as /turns-valclass/history
    expect(forecast.weeks[0].deliveries).toEqual([{ id: null, poNumber: 'Draft', qty: 400 }]);
  });

  test('reports an error for an item whose material has no MRP master data row, without failing the rest', async () => {
    db.listVendorMaterialsForSuggestions.mockResolvedValueOnce([materialRow()]);
    db.listOpenIncomingOrders.mockResolvedValueOnce([]);
    db.listDemandAdjustments.mockResolvedValueOnce([]);

    const res = await request(appMrp).post('/order-suggestions/preview').send({
      deliveryDate: '2026-01-16',
      items: [{ material: 'M1', orderQty: 400 }, { material: 'UNKNOWN', orderQty: 100 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.data[0].stockForecast).toBeDefined();
    expect(res.body.data[1]).toEqual({ material: 'UNKNOWN', error: 'Material not found in MRP master data.' });
  });
});

// POST /order-suggestions/accept-batch — added deliveryDate passthrough so the "Start New
// Order" builder's shared delivery-date field is actually honored on confirm, not just used for
// the live preview above.
describe('POST /order-suggestions/accept-batch — deliveryDate override', () => {
  test('passes each item\'s deliveryDate through buildAcceptPayload to the persisted suggestion', async () => {
    db.getVendorMaterialConstraints.mockResolvedValue({ MaterialMoqQty: 0, MaterialMaxQty: 0 });
    db.getVendorOrderConstraints.mockResolvedValue({ OrderMoqQty: null, OrderMaxQty: null });
    db.acceptOrderSuggestion.mockResolvedValue(1);

    const res = await request(appMrp).post('/order-suggestions/accept-batch').send({
      vendorId: 1,
      orderDate: '2026-01-15',
      items: [{ vendorMaterialId: 1, material: 'M1', orderQty: 500, deliveryDate: '2026-02-10' }],
    });

    expect(res.status).toBe(200);
    expect(db.acceptOrderSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({ material: 'M1', orderQty: 500, deliveryDate: new Date('2026-02-10') })
    );
  });

  test('falls back to the lead-time-derived delivery date when no override is given', async () => {
    db.getVendorMaterialConstraints.mockResolvedValue({ MaterialMoqQty: 0, MaterialMaxQty: 0 });
    db.getVendorOrderConstraints.mockResolvedValue({ OrderMoqQty: null, OrderMaxQty: null });
    db.acceptOrderSuggestion.mockResolvedValue(1);

    const res = await request(appMrp).post('/order-suggestions/accept-batch').send({
      vendorId: 1,
      orderDate: '2026-01-15',
      items: [{ vendorMaterialId: 1, material: 'M1', orderQty: 500, leadTimeDays: 5 }],
    });

    expect(res.status).toBe(200);
    const payload = db.acceptOrderSuggestion.mock.calls[0][0];
    // 2026-01-15 is a Thursday — 5 working days later is 2026-01-22.
    expect(payload.deliveryDate.toISOString().slice(0, 10)).toBe('2026-01-22');
  });
});
