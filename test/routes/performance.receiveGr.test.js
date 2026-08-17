// routes/performance.js's postGoodsReceiptToSap (not exported — exercised
// here through POST /order-suggestions/shipments/:shipmentId/receive) —
// specifically that Quantity is ALWAYS sent as the operator-confirmed
// ReceivedQty, on every call, regardless of whether it matches OrderQty —
// per the user, the portal's confirmation of what was physically delivered
// must win even if the PO's real quantity in SAP has since changed and
// never synced back into Nexus. This also covers over-delivery
// (ReceivedQty > OrderQty), which is a legitimate confirmation with no cap
// anywhere in this path, not an error condition — and the one exception,
// ReceivedQty === 0, which is deliberately never sent to SAP at all (see
// postGoodsReceiptToSap's zeroQty comment): GoodsReceiptHelper on the
// SapServer side treats Quantity 0 identically to "not supplied" and would
// silently fall back to booking the FULL outstanding PO quantity, the exact
// opposite of what a confirmed 0 means. db.markShipmentReceived is mocked
// to directly invoke whatever postGoodsReceipt callback the route wires up,
// with a test-controlled order/shipment shape, rather than exercising the
// real DB-layer function (covered separately in
// test/unit/performancesql.test.js).
//
// Also covers the Reference/AddressCode field swap: RM07M-LFSNR carries the
// order line's own SupplierReference (the supplier's paperwork reference,
// not Nexus's internal shipment reference), and MKPF-BKTXT carries the
// shipment reference instead — see postGoodsReceiptToSap's own comment for
// why that field was free to repurpose here.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

// performance.js pulls in ./performancesap.js at import time, which calls
// axios.create(...) at module scope for its own unrelated client — needs a
// stand-in so that side-effecting import doesn't throw, even though this
// test never exercises anything from that module.
const axiosMock = { post: jest.fn(), create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

const db = { markShipmentReceived: jest.fn() };
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
  db.markShipmentReceived.mockReset();
  axiosMock.post.mockReset();
  axiosMock.post.mockResolvedValue({
    data: { success: true, data: { type: 'S', documentNumber: '5000000001' } },
  });
});

const shipment = { ShipmentReference: 'INB-000001', TrackingNumber: 'TRACK1', ReceivedAtUtc: new Date('2026-08-06T09:00:00Z') };

// Simulates the real markShipmentReceived's loop closely enough for this
// test's purpose: calls the caller-supplied postGoodsReceipt with one
// order/the shared shipment, then reports whatever it returned.
function mockOneOrderReceive(order) {
  db.markShipmentReceived.mockImplementation(async (shipmentId, { postGoodsReceipt }) => {
    const result = await postGoodsReceipt(order, shipment);
    return { orderCount: 1, sapResults: [{ suggestionId: order.SuggestionId, material: order.Material, ...result }] };
  });
}

describe('POST /order-suggestions/shipments/:shipmentId/receive — SAP GR quantity', () => {
  test('sends ReceivedQty as Quantity even when it matches OrderQty (full receipt) — never falls back to SAP XFULL', async () => {
    mockOneOrderReceive({ SuggestionId: 1, Material: 'MAT1', PoNumber: '4500012345', PoItemNumber: '00010', OrderQty: 100, ReceivedQty: 100 });

    const res = await request(app).post('/order-suggestions/shipments/1/receive').send({});

    expect(res.status).toBe(200);
    expect(axiosMock.post).toHaveBeenCalledTimes(1);
    const [, body] = axiosMock.post.mock.calls[0];
    expect(body.Quantity).toBe(100);
    expect(body.PurchaseOrder).toBe('4500012345');
  });

  test('sends ReceivedQty as Quantity for a short delivery', async () => {
    mockOneOrderReceive({ SuggestionId: 1, Material: 'MAT1', PoNumber: '4500012345', PoItemNumber: '00010', OrderQty: 100, ReceivedQty: 80 });

    const res = await request(app).post('/order-suggestions/shipments/1/receive').send({});

    expect(res.status).toBe(200);
    const [, body] = axiosMock.post.mock.calls[0];
    expect(body.Quantity).toBe(80);
  });

  test('sends ReceivedQty as Quantity for an over delivery, uncapped against OrderQty', async () => {
    mockOneOrderReceive({ SuggestionId: 1, Material: 'MAT1', PoNumber: '4500012345', PoItemNumber: '00010', OrderQty: 100, ReceivedQty: 140 });

    const res = await request(app).post('/order-suggestions/shipments/1/receive').send({});

    expect(res.status).toBe(200);
    const [, body] = axiosMock.post.mock.calls[0];
    expect(body.Quantity).toBe(140);
  });

  test('sends ReceivedQty as Quantity even when it would still exceed OrderQty after operator override (no cap anywhere in the request body)', async () => {
    // A large over-delivery — e.g. a vendor sent a full pallet extra —
    // must reach SAP exactly as confirmed, not clamped to OrderQty.
    mockOneOrderReceive({ SuggestionId: 1, Material: 'MAT1', PoNumber: '4500012345', PoItemNumber: '00010', OrderQty: 100, ReceivedQty: 250 });

    await request(app).post('/order-suggestions/shipments/1/receive').send({});

    const [, body] = axiosMock.post.mock.calls[0];
    expect(body.Quantity).toBe(250);
  });

  test('reports skipped/noPo without calling SAP when the order has no PO item number, regardless of quantity', async () => {
    mockOneOrderReceive({ SuggestionId: 1, Material: 'MAT1', PoNumber: '4500012345', PoItemNumber: null, OrderQty: 100, ReceivedQty: 100 });

    const res = await request(app).post('/order-suggestions/shipments/1/receive').send({});

    expect(axiosMock.post).not.toHaveBeenCalled();
    expect(res.body.data.sapResults[0]).toMatchObject({ skipped: true, noPo: true });
  });

  test('reports skipped/zeroQty without calling SAP when ReceivedQty is confirmed at 0 — never falls through to SAP XFULL booking the full PO qty', async () => {
    mockOneOrderReceive({ SuggestionId: 1, Material: 'MAT1', PoNumber: '4500012345', PoItemNumber: '00010', OrderQty: 100, ReceivedQty: 0 });

    const res = await request(app).post('/order-suggestions/shipments/1/receive').send({});

    expect(axiosMock.post).not.toHaveBeenCalled();
    expect(res.body.data.sapResults[0]).toMatchObject({ skipped: true, zeroQty: true });
  });

  // ReceivedQty is always stored in the material's SAP base unit (KG), but
  // SAP's goods-receipt posting is against a specific PO line and needs the
  // quantity in THAT PO's own order unit (log.Vendor.OrderMoqUom — e.g. LB
  // for DeWAL, the same unit the PO was created in) — see
  // postGoodsReceiptToSap's own comment.
  test('converts ReceivedQty from the base unit into the vendor order unit before sending Quantity to SAP', async () => {
    mockOneOrderReceive({
      SuggestionId: 1, Material: 'MAT1', PoNumber: '4500012345', PoItemNumber: '00010',
      OrderQty: 100, ReceivedQty: 100, OrderMoqUom: 'LB', MaterialUom: 'KG',
    });

    await request(app).post('/order-suggestions/shipments/1/receive').send({});

    const [, body] = axiosMock.post.mock.calls[0];
    // 100 KG / 0.45359237 = 220.462262 LB.
    expect(body.Quantity).toBeCloseTo(220.462262, 5);
  });

  test('leaves Quantity unconverted when the vendor order unit matches the base unit (KG)', async () => {
    mockOneOrderReceive({
      SuggestionId: 1, Material: 'MAT1', PoNumber: '4500012345', PoItemNumber: '00010',
      OrderQty: 100, ReceivedQty: 80, OrderMoqUom: 'KG', MaterialUom: 'KG',
    });

    await request(app).post('/order-suggestions/shipments/1/receive').send({});

    const [, body] = axiosMock.post.mock.calls[0];
    expect(body.Quantity).toBe(80);
  });
});

describe('POST /order-suggestions/shipments/:shipmentId/receive — SAP GR reference fields', () => {
  test('sends the order line\'s SupplierReference as Reference (RM07M-LFSNR), not the shipment reference', async () => {
    mockOneOrderReceive({
      SuggestionId: 1, Material: 'MAT1', PoNumber: '4500012345', PoItemNumber: '00010',
      OrderQty: 100, ReceivedQty: 100, SupplierReference: 'PAPERWORK-99',
    });

    await request(app).post('/order-suggestions/shipments/1/receive').send({});

    const [, body] = axiosMock.post.mock.calls[0];
    expect(body.Reference).toBe('PAPERWORK-99');
  });

  test('sends the shipment reference as AddressCode (MKPF-BKTXT) instead', async () => {
    mockOneOrderReceive({
      SuggestionId: 1, Material: 'MAT1', PoNumber: '4500012345', PoItemNumber: '00010',
      OrderQty: 100, ReceivedQty: 100, SupplierReference: 'PAPERWORK-99',
    });

    await request(app).post('/order-suggestions/shipments/1/receive').send({});

    const [, body] = axiosMock.post.mock.calls[0];
    expect(body.AddressCode).toBe(shipment.ShipmentReference);
  });
});
