// routes/performance.js's POST /order-suggestions/regenerate-pdf (Tracked
// Orders' "Recreate PO PDF") — rebuilds and re-saves a PDF for an
// already-created PO without touching SAP at all. buildPoPdf itself (real
// pdfkit rendering) is mocked out — this only exercises the route's own
// logic: fetching the PO's order lines, best-effort price lookup, and
// writing the result to LOGISTICS_PO_ROOT (a real temp-dir filesystem write,
// same "real fs, wrapped" convention used by freightbooking.test.js — see
// CLAUDE.md's Testing section).

import { describe, test, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const axiosMock = { post: jest.fn(), get: jest.fn(), create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

const db = { listOrderSuggestionsByPoNumber: jest.fn() };
jest.unstable_mockModule('../../routes/performancesql.js', () => db);

const buildPoPdfMock = jest.fn();
jest.unstable_mockModule('../../lib/poPdf.js', () => ({ buildPoPdf: buildPoPdfMock }));

const mrpUser = { ...operatorUser, permissions: ['LOG_MRP'] };

let performanceRouter;
let app;
let poRoot;

beforeAll(async () => {
  poRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-po-pdf-test-'));
  process.env.LOGISTICS_PO_ROOT = poRoot;
  ({ default: performanceRouter } = await import('../../routes/performance.js'));
  app = buildTestApp(performanceRouter, { sessionUser: mrpUser });
});

afterAll(() => {
  fs.rmSync(poRoot, { recursive: true, force: true });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  db.listOrderSuggestionsByPoNumber.mockReset();
  axiosMock.get.mockReset();
  axiosMock.get.mockResolvedValue({ data: { success: true, data: {} } });
  buildPoPdfMock.mockReset();
  buildPoPdfMock.mockResolvedValue(Buffer.from('%PDF-fake'));
});

const orderLine = (overrides) => ({
  SuggestionId: 1, VendorId: 1, VendorName: 'DeWAL', SapVendorNumber: '0000074023',
  Currency: 'USD', OrderMoqUom: 'LB', Incoterms: 'EXW',
  Material: 'M1', MaterialText: 'Widget', Uom: 'KG',
  OrderQty: 1360.777, OrderDate: '2026-08-01T00:00:00Z',
  DeliveryDate: '2026-09-01T00:00:00Z', ReadyToCollectDate: '2026-08-25T00:00:00Z',
  PoNumber: '4500012345', PoItemNumber: '00010',
  ...overrides,
});

test('400s without a poNumber', async () => {
  const res = await request(app).post('/order-suggestions/regenerate-pdf').send({});
  expect(res.status).toBe(400);
  expect(db.listOrderSuggestionsByPoNumber).not.toHaveBeenCalled();
});

test('404s when no order lines exist for the given PO number', async () => {
  db.listOrderSuggestionsByPoNumber.mockResolvedValueOnce([]);
  const res = await request(app).post('/order-suggestions/regenerate-pdf').send({ poNumber: '4500099999' });
  expect(res.status).toBe(404);
});

test('rebuilds the PDF with an EXW-aware, unit-converted item and saves it to LOGISTICS_PO_ROOT, without calling SAP to create/change anything', async () => {
  db.listOrderSuggestionsByPoNumber.mockResolvedValueOnce([orderLine()]);

  const res = await request(app).post('/order-suggestions/regenerate-pdf').send({ poNumber: '4500012345' });

  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ purchaseOrder: '4500012345', poPdfSaved: true });
  expect(axiosMock.post).not.toHaveBeenCalled(); // never touches SAP itself

  const [pdfArgs] = buildPoPdfMock.mock.calls;
  expect(pdfArgs[0]).toMatchObject({ poNumber: '4500012345', vendorName: 'DeWAL', currency: 'USD', incoterms: 'EXW' });
  const [item] = pdfArgs[0].items;
  expect(item.uom).toBe('LB');
  expect(item.quantity).toBeCloseTo(3000, 1); // 1360.777 KG -> ~3000 LB
  expect(item.isExw).toBe(true);
  expect(item.deliveryDate).toBe('2026-08-25T00:00:00Z'); // ReadyToCollectDate, not DeliveryDate, for EXW

  const saved = fs.readFileSync(path.join(poRoot, 'DeWAL', '4500012345.pdf'));
  expect(saved.toString()).toBe('%PDF-fake');
});

test('uses the SAP-queried price for the matching PO item when the lookup succeeds', async () => {
  axiosMock.get.mockResolvedValueOnce({ data: { success: true, data: { '00010': 4.55 } } });
  db.listOrderSuggestionsByPoNumber.mockResolvedValueOnce([orderLine()]);

  await request(app).post('/order-suggestions/regenerate-pdf').send({ poNumber: '4500012345' });

  const [pdfArgs] = buildPoPdfMock.mock.calls;
  expect(pdfArgs[0].items[0].netPrice).toBe(4.55);
});

test('falls back to a null price (not a thrown error) when the SAP price lookup itself fails', async () => {
  axiosMock.get.mockRejectedValueOnce(new Error('SAP unreachable'));
  db.listOrderSuggestionsByPoNumber.mockResolvedValueOnce([orderLine()]);

  const res = await request(app).post('/order-suggestions/regenerate-pdf').send({ poNumber: '4500012345' });

  expect(res.status).toBe(200);
  expect(buildPoPdfMock.mock.calls[0][0].items[0].netPrice).toBeNull();
});

test('a non-EXW order keeps DeliveryDate, not ReadyToCollectDate', async () => {
  db.listOrderSuggestionsByPoNumber.mockResolvedValueOnce([orderLine({ Incoterms: 'DAP' })]);

  await request(app).post('/order-suggestions/regenerate-pdf').send({ poNumber: '4500012345' });

  const item = buildPoPdfMock.mock.calls[0][0].items[0];
  expect(item.isExw).toBe(false);
  expect(item.deliveryDate).toBe('2026-09-01T00:00:00Z');
});
