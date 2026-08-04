// Targets performancesql.js directly (mssql mocked, not performancesql.js
// itself) — specifically createDemandAdjustment's overlap-rejection rule,
// called out in the file's own comments as the thing that keeps its 400s
// meaningful. Since mssql is mocked, these tests verify the JS-side handling
// of an overlap query result (throwing a 400 with a well-formatted message,
// including the null-EndDate "indefinitely" case) — not the real SQL WHERE
// clause's date-range predicate itself, which only a real-DB integration
// test could confirm. The rest of this 1984-line file's query logic isn't
// covered yet; performance.test.js covers the routing layer that calls into it.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let createDemandAdjustment;
let markShipmentReceived;

beforeAll(async () => {
  ({ createDemandAdjustment, markShipmentReceived } = await import('../../routes/performancesql.js'));
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

describe('createDemandAdjustment', () => {
  test('rejects with a 400 when an overlapping adjustment already exists for the material', async () => {
    dbRequest.query.mockResolvedValueOnce({
      recordset: [{ AdjustmentId: 5, StartDate: '2026-01-01T00:00:00Z', EndDate: '2026-03-01T00:00:00Z' }],
    });

    await expect(createDemandAdjustment({
      material: '30005R', startDate: '2026-02-01T00:00:00', endDate: '2026-02-15T00:00:00', usagePercent: 50,
    })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('2026-01-01 to 2026-03-01'),
    });

    // Never reaches the INSERT once an overlap is found.
    expect(dbRequest.query).toHaveBeenCalledTimes(1);
  });

  test('creates the adjustment when no overlap exists', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [] }) // no overlap
      .mockResolvedValueOnce({ recordset: [{ AdjustmentId: 9 }] }); // INSERT ... OUTPUT

    const id = await createDemandAdjustment({
      material: '30005R', startDate: '2026-02-01T00:00:00', endDate: '2026-02-15T00:00:00', usagePercent: 50,
    });

    expect(id).toBe(9);
  });

  test('formats an open-ended overlap (no EndDate) as "indefinitely" rather than crashing on the null date', async () => {
    dbRequest.query.mockResolvedValueOnce({
      recordset: [{ AdjustmentId: 3, StartDate: '2026-01-01T00:00:00Z', EndDate: null }],
    });

    await expect(createDemandAdjustment({
      material: '30005R', startDate: '2026-06-01T00:00:00', endDate: '2026-07-01T00:00:00', usagePercent: 25,
    })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('2026-01-01 to indefinitely'),
    });
  });
});

// Inbound Log's "Mark Received" action. Query order inside
// markShipmentReceived: (1) shipment lookup, (2) non-cancelled linked
// orders, (3) UPDATE PurchaseOrderShipment, then one UPDATE
// PurchaseOrderSuggestion per order (Status='Booked' + ReceivedQty +
// SapMaterialDocument/SapGrError/SapGrSkipped). postGoodsReceipt (when
// supplied) is an injected callback, not a DB call, so it doesn't add to
// the query count — routes/performance.js supplies the real SapServer HTTP
// call in production; these tests exercise markShipmentReceived's own
// skip/success/failure handling around whatever the callback returns.
describe('markShipmentReceived', () => {
  function queueShipmentAndOrders(orders, { alreadyReceived = false } = {}) {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ ShipmentId: 1, ShipmentReference: 'INB-000001', TrackingNumber: 'TRACK1', ReceivedAtUtc: alreadyReceived ? '2026-01-01T00:00:00Z' : null }] })
      .mockResolvedValueOnce({ recordset: orders });
  }

  function receivedQtyCalls() {
    return dbRequest.input.mock.calls.filter(call => call[0] === 'receivedQty').map(call => call[2]);
  }

  function inputCalls(name) {
    return dbRequest.input.mock.calls.filter(call => call[0] === name).map(call => call[2]);
  }

  test('defaults each order line to its OrderQty when no receivedQuantities are given', async () => {
    queueShipmentAndOrders([
      { SuggestionId: 1, Material: 'MAT1', OrderQty: 100 },
      { SuggestionId: 2, Material: 'MAT2', OrderQty: 50 },
    ]);
    dbRequest.query.mockResolvedValue({ recordset: [] }); // remaining UPDATE calls

    const result = await markShipmentReceived(1, { receivedBy: 'tester' });

    expect(result.orderCount).toBe(2);
    expect(receivedQtyCalls()).toEqual([100, 50]);
  });

  test('uses the confirmed receivedQuantities map, falling back to OrderQty for lines it omits', async () => {
    queueShipmentAndOrders([
      { SuggestionId: 1, Material: 'MAT1', OrderQty: 100 },
      { SuggestionId: 2, Material: 'MAT2', OrderQty: 50 },
    ]);
    dbRequest.query.mockResolvedValue({ recordset: [] });

    // Order 1 arrived short (80 of 100); order 2's qty is omitted from the
    // map entirely and should fall back to its full OrderQty.
    await markShipmentReceived(1, { receivedBy: 'tester', receivedQuantities: { 1: 80 } });

    expect(receivedQtyCalls()).toEqual([80, 50]);
  });

  test('rejects with a 400 naming the material when a received quantity is invalid, before writing anything', async () => {
    queueShipmentAndOrders([{ SuggestionId: 1, Material: 'MAT1', OrderQty: 100 }]);

    await expect(markShipmentReceived(1, { receivedQuantities: { 1: -5 } })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('MAT1'),
    });

    // Only the two lookups ran — no UPDATE was issued once validation failed.
    expect(dbRequest.query).toHaveBeenCalledTimes(2);
  });

  test('rejects with a 400 when the shipment has already been marked received', async () => {
    queueShipmentAndOrders([], { alreadyReceived: true });

    await expect(markShipmentReceived(1, {})).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('already been marked received'),
    });
    expect(dbRequest.query).toHaveBeenCalledTimes(1);
  });

  test('rejects with a 404 when the shipment does not exist', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });

    await expect(markShipmentReceived(999, {})).rejects.toMatchObject({
      statusCode: 404,
      message: expect.stringContaining('Shipment not found'),
    });
  });

  test('never calls postGoodsReceipt when skipSap is true, and stamps every line SapGrSkipped', async () => {
    queueShipmentAndOrders([{ SuggestionId: 1, Material: 'MAT1', OrderQty: 100, PoNumber: '4500012345', PoItemNumber: '00010' }]);
    dbRequest.query.mockResolvedValue({ recordset: [] });
    const postGoodsReceipt = jest.fn().mockResolvedValue({ success: true, documentNumber: '5000000001' });

    const result = await markShipmentReceived(1, { skipSap: true, postGoodsReceipt });

    expect(postGoodsReceipt).not.toHaveBeenCalled();
    expect(result.sapResults).toEqual([{ suggestionId: 1, material: 'MAT1', skipped: true }]);
    expect(inputCalls('sapGrSkipped')).toEqual([1]);
    expect(inputCalls('sapMaterialDocument')).toEqual([null]);
  });

  test('never calls postGoodsReceipt when none is supplied (skipSap omitted) — same as skipSap:true', async () => {
    queueShipmentAndOrders([{ SuggestionId: 1, Material: 'MAT1', OrderQty: 100 }]);
    dbRequest.query.mockResolvedValue({ recordset: [] });

    const result = await markShipmentReceived(1, {});

    expect(result.sapResults).toEqual([{ suggestionId: 1, material: 'MAT1', skipped: true }]);
  });

  test('stores the returned documentNumber and clears SapGrSkipped on a successful post', async () => {
    queueShipmentAndOrders([{ SuggestionId: 1, Material: 'MAT1', OrderQty: 100, PoNumber: '4500012345', PoItemNumber: '00010' }]);
    dbRequest.query.mockResolvedValue({ recordset: [] });
    const postGoodsReceipt = jest.fn().mockResolvedValue({ success: true, documentNumber: '5000000001' });

    const result = await markShipmentReceived(1, { postGoodsReceipt });

    expect(postGoodsReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ SuggestionId: 1, PoNumber: '4500012345', ReceivedQty: 100 }),
      expect.objectContaining({ ShipmentReference: 'INB-000001', TrackingNumber: 'TRACK1' }),
    );
    expect(result.sapResults).toEqual([{ suggestionId: 1, material: 'MAT1', success: true, documentNumber: '5000000001' }]);
    expect(inputCalls('sapMaterialDocument')).toEqual(['5000000001']);
    expect(inputCalls('sapGrError')).toEqual([null]);
    expect(inputCalls('sapGrSkipped')).toEqual([0]);
  });

  test('records a per-line SAP failure but still books it and continues to the next line', async () => {
    queueShipmentAndOrders([
      { SuggestionId: 1, Material: 'MAT1', OrderQty: 100, PoNumber: '4500012345', PoItemNumber: '00010' },
      { SuggestionId: 2, Material: 'MAT2', OrderQty: 50,  PoNumber: '4500012345', PoItemNumber: '00020' },
    ]);
    dbRequest.query.mockResolvedValue({ recordset: [] });
    const postGoodsReceipt = jest.fn()
      .mockResolvedValueOnce({ success: false, error: 'Posting period not open.' })
      .mockResolvedValueOnce({ success: true, documentNumber: '5000000002' });

    const result = await markShipmentReceived(1, { postGoodsReceipt });

    expect(postGoodsReceipt).toHaveBeenCalledTimes(2);
    expect(result.orderCount).toBe(2); // both still booked despite line 1's SAP failure
    expect(result.sapResults).toEqual([
      { suggestionId: 1, material: 'MAT1', success: false, error: 'Posting period not open.' },
      { suggestionId: 2, material: 'MAT2', success: true, documentNumber: '5000000002' },
    ]);
    expect(inputCalls('sapGrError')).toEqual(['Posting period not open.', null]);
  });

  test('treats a thrown postGoodsReceipt as a failure rather than aborting the receive', async () => {
    queueShipmentAndOrders([{ SuggestionId: 1, Material: 'MAT1', OrderQty: 100, PoNumber: '4500012345', PoItemNumber: '00010' }]);
    dbRequest.query.mockResolvedValue({ recordset: [] });
    const postGoodsReceipt = jest.fn().mockRejectedValue(new Error('SapServer unreachable'));

    const result = await markShipmentReceived(1, { postGoodsReceipt });

    expect(result.orderCount).toBe(1);
    expect(result.sapResults).toEqual([{ suggestionId: 1, material: 'MAT1', success: false, error: 'SapServer unreachable' }]);
  });
});
