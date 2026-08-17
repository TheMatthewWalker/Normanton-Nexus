// routes/performance.js's buildAcceptPayload (exercised through POST
// /order-suggestions/accept and /order-suggestions/accept-batch) — the
// expected-dispatch-date calc (readyToCollectDate = deliveryDate minus the
// vendor's TransitTimeDays, working days) used to only run for EXW
// vendors. Per the user, this is now computed for every Incoterm — their
// own process (notified on dispatch, creates the shipment then) doesn't
// depend on who's contractually arranging transit. See buildAcceptPayload's
// own comment in routes/performance.js.

import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const db = {
  getVendorMaterialConstraints: jest.fn(),
  getVendorOrderConstraints: jest.fn(),
  acceptOrderSuggestion: jest.fn(),
};
jest.unstable_mockModule('../../routes/performancesql.js', () => db);

const mrpUser = { ...operatorUser, permissions: ['LOG_MRP'] };
let performanceRouter;
let app;

beforeAll(async () => {
  ({ default: performanceRouter } = await import('../../routes/performance.js'));
  app = buildTestApp(performanceRouter, { sessionUser: mrpUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  Object.values(db).forEach(fn => fn.mockReset());
  db.getVendorMaterialConstraints.mockResolvedValue(null);
  db.getVendorOrderConstraints.mockResolvedValue(null);
  db.acceptOrderSuggestion.mockResolvedValue(1);
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-01-05T12:00:00.000Z')); // a Monday
});

afterEach(() => { jest.useRealTimers(); });

function baseBody(overrides) {
  return {
    vendorMaterialId: 1, vendorId: 1, material: 'M1', orderQty: 100,
    orderDate: '2026-01-05', leadTimeDays: 10, transitTimeDays: 3,
    ...overrides,
  };
}

test('computes readyToCollectDate for a DAP (non-EXW) vendor — previously left null', async () => {
  const res = await request(app).post('/order-suggestions/accept').send(baseBody({ incoterms: 'DAP' }));

  expect(res.status).toBe(200);
  const payload = db.acceptOrderSuggestion.mock.calls[0][0];
  // deliveryDate = 2026-01-05 + 10 working days = 2026-01-19 (Mon);
  // readyToCollectDate = that minus 3 working days = 2026-01-14 (Wed).
  expect(payload.deliveryDate.toISOString().slice(0, 10)).toBe('2026-01-19');
  expect(payload.readyToCollectDate.toISOString().slice(0, 10)).toBe('2026-01-14');
  expect(payload.transitTimeDaysUsed).toBe(3);
});

test('computes readyToCollectDate the same way for EXW — behaviour unchanged there', async () => {
  const res = await request(app).post('/order-suggestions/accept').send(baseBody({ incoterms: 'EXW' }));

  expect(res.status).toBe(200);
  const payload = db.acceptOrderSuggestion.mock.calls[0][0];
  expect(payload.readyToCollectDate.toISOString().slice(0, 10)).toBe('2026-01-14');
});

test('defaults to a dispatch date equal to the delivery date when no transit time is set', async () => {
  const res = await request(app).post('/order-suggestions/accept').send(baseBody({ incoterms: 'DAP', transitTimeDays: null }));

  expect(res.status).toBe(200);
  const payload = db.acceptOrderSuggestion.mock.calls[0][0];
  expect(payload.readyToCollectDate.toISOString().slice(0, 10)).toBe(payload.deliveryDate.toISOString().slice(0, 10));
  expect(payload.transitTimeDaysUsed).toBe(0);
});

test('accept-batch computes it per item too, regardless of Incoterm', async () => {
  const res = await request(app).post('/order-suggestions/accept-batch').send({
    vendorId: 1,
    orderDate: '2026-01-05',
    items: [
      { vendorMaterialId: 1, material: 'M1', orderQty: 100, leadTimeDays: 10, transitTimeDays: 3, incoterms: 'FOB' },
    ],
  });

  expect(res.status).toBe(200);
  const payload = db.acceptOrderSuggestion.mock.calls[0][0];
  expect(payload.readyToCollectDate.toISOString().slice(0, 10)).toBe('2026-01-14');
});
