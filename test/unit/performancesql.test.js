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
let undoShipmentReceived;
let addManualInboundItem;
let removeManualInboundItem;
let upsertForecastAccuracyLog;
let updateOrderSuggestionStatus;
let updateOrderSuggestionPoItem;
let deleteOrderSuggestion;
let assignOrderShipment;
let addVendorMaterial;
let updateVendorMaterial;

beforeAll(async () => {
  ({
    createDemandAdjustment, markShipmentReceived, undoShipmentReceived, addManualInboundItem,
    removeManualInboundItem, upsertForecastAccuracyLog, updateOrderSuggestionStatus,
    updateOrderSuggestionPoItem, deleteOrderSuggestion, assignOrderShipment,
    addVendorMaterial, updateVendorMaterial,
  } = await import('../../routes/performancesql.js'));
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
// PurchaseOrderSuggestion per order (Status='Received' + ReceivedQty +
// SupplierReference + SapMaterialDocument/SapGrError/SapGrSkipped).
// postGoodsReceipt (when
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

  test('flips each order line straight to Received (not the retired Booked status)', async () => {
    queueShipmentAndOrders([{ SuggestionId: 1, Material: 'MAT1', OrderQty: 100, SupplierReference: 'SUP-1' }]);
    dbRequest.query.mockResolvedValue({ recordset: [] });

    await markShipmentReceived(1, { receivedBy: 'tester' });

    const updateCall = dbRequest.query.mock.calls.find(call => /UPDATE log\.PurchaseOrderSuggestion/.test(call[0]));
    expect(updateCall[0]).toContain("Status = 'Received'");
    expect(updateCall[0]).not.toContain("Status = 'Booked'");
  });

  test('defaults each order line to its OrderQty when no receivedQuantities are given', async () => {
    queueShipmentAndOrders([
      { SuggestionId: 1, Material: 'MAT1', OrderQty: 100, SupplierReference: 'SUP-1' },
      { SuggestionId: 2, Material: 'MAT2', OrderQty: 50, SupplierReference: 'SUP-2' },
    ]);
    dbRequest.query.mockResolvedValue({ recordset: [] }); // remaining UPDATE calls

    const result = await markShipmentReceived(1, { receivedBy: 'tester' });

    expect(result.orderCount).toBe(2);
    expect(receivedQtyCalls()).toEqual([100, 50]);
  });

  test('uses the confirmed receivedQuantities map, falling back to OrderQty for lines it omits', async () => {
    queueShipmentAndOrders([
      { SuggestionId: 1, Material: 'MAT1', OrderQty: 100, SupplierReference: 'SUP-1' },
      { SuggestionId: 2, Material: 'MAT2', OrderQty: 50, SupplierReference: 'SUP-2' },
    ]);
    dbRequest.query.mockResolvedValue({ recordset: [] });

    // Order 1 arrived short (80 of 100); order 2's qty is omitted from the
    // map entirely and should fall back to its full OrderQty.
    await markShipmentReceived(1, { receivedBy: 'tester', receivedQuantities: { 1: 80 } });

    expect(receivedQtyCalls()).toEqual([80, 50]);
  });

  // ReceivedQty is always stored in the material's SAP base unit (KG) —
  // see lib/unitConversion.js's header comment — but an operator confirming
  // receipt off the supplier's own delivery paperwork enters the quantity
  // in the vendor's actual order unit (log.Vendor.OrderMoqUom — e.g. LB for
  // DeWAL). A freshly-entered value must be converted back to KG before
  // being stored; the "nothing entered, assume the full order arrived"
  // default (falling back to OrderQty) is already in KG and must NOT be
  // converted a second time.
  test('converts a freshly-entered receivedQuantities value from the vendor order unit into the base unit before storing', async () => {
    queueShipmentAndOrders([
      { SuggestionId: 1, Material: 'MAT1', OrderQty: 100, SupplierReference: 'SUP-1', OrderMoqUom: 'LB', MaterialUom: 'KG' },
    ]);
    dbRequest.query.mockResolvedValue({ recordset: [] });

    // Operator reads "50 LB" off the supplier's paperwork and types 50.
    await markShipmentReceived(1, { receivedBy: 'tester', receivedQuantities: { 1: 50 } });

    // 50 LB * 0.45359237 = 22.6796185 KG.
    expect(receivedQtyCalls()[0]).toBeCloseTo(22.6796185, 6);
  });

  test('does not double-convert the OrderQty default for a vendor with a non-KG order unit', async () => {
    queueShipmentAndOrders([
      { SuggestionId: 1, Material: 'MAT1', OrderQty: 100, SupplierReference: 'SUP-1', OrderMoqUom: 'LB', MaterialUom: 'KG' },
    ]);
    dbRequest.query.mockResolvedValue({ recordset: [] });

    await markShipmentReceived(1, { receivedBy: 'tester' }); // no receivedQuantities supplied

    expect(receivedQtyCalls()).toEqual([100]); // OrderQty (already KG) passed through unchanged
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
    queueShipmentAndOrders([{ SuggestionId: 1, Material: 'MAT1', OrderQty: 100, PoNumber: '4500012345', PoItemNumber: '00010', SupplierReference: 'SUP-1' }]);
    dbRequest.query.mockResolvedValue({ recordset: [] });
    const postGoodsReceipt = jest.fn().mockResolvedValue({ success: true, documentNumber: '5000000001' });

    const result = await markShipmentReceived(1, { skipSap: true, postGoodsReceipt });

    expect(postGoodsReceipt).not.toHaveBeenCalled();
    expect(result.sapResults).toEqual([{ suggestionId: 1, material: 'MAT1', skipped: true }]);
    expect(inputCalls('sapGrSkipped')).toEqual([1]);
    expect(inputCalls('sapMaterialDocument')).toEqual([null]);
  });

  test('never calls postGoodsReceipt when none is supplied (skipSap omitted) — same as skipSap:true', async () => {
    queueShipmentAndOrders([{ SuggestionId: 1, Material: 'MAT1', OrderQty: 100, SupplierReference: 'SUP-1' }]);
    dbRequest.query.mockResolvedValue({ recordset: [] });

    const result = await markShipmentReceived(1, {});

    expect(result.sapResults).toEqual([{ suggestionId: 1, material: 'MAT1', skipped: true }]);
  });

  test('stores the returned documentNumber and clears SapGrSkipped on a successful post', async () => {
    queueShipmentAndOrders([{ SuggestionId: 1, Material: 'MAT1', OrderQty: 100, PoNumber: '4500012345', PoItemNumber: '00010', SupplierReference: 'SUP-1' }]);
    dbRequest.query.mockResolvedValue({ recordset: [] });
    const postGoodsReceipt = jest.fn().mockResolvedValue({ success: true, documentNumber: '5000000001' });

    const result = await markShipmentReceived(1, { postGoodsReceipt });

    expect(postGoodsReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ SuggestionId: 1, PoNumber: '4500012345', ReceivedQty: 100, SupplierReference: 'SUP-1' }),
      expect.objectContaining({ ShipmentReference: 'INB-000001', TrackingNumber: 'TRACK1' }),
    );
    expect(result.sapResults).toEqual([{ suggestionId: 1, material: 'MAT1', success: true, documentNumber: '5000000001' }]);
    expect(inputCalls('sapMaterialDocument')).toEqual(['5000000001']);
    expect(inputCalls('sapGrError')).toEqual([null]);
    expect(inputCalls('sapGrSkipped')).toEqual([0]);
  });

  test('records a per-line SAP failure but still books it and continues to the next line', async () => {
    queueShipmentAndOrders([
      { SuggestionId: 1, Material: 'MAT1', OrderQty: 100, PoNumber: '4500012345', PoItemNumber: '00010', SupplierReference: 'SUP-1' },
      { SuggestionId: 2, Material: 'MAT2', OrderQty: 50,  PoNumber: '4500012345', PoItemNumber: '00020', SupplierReference: 'SUP-2' },
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
    queueShipmentAndOrders([{ SuggestionId: 1, Material: 'MAT1', OrderQty: 100, PoNumber: '4500012345', PoItemNumber: '00010', SupplierReference: 'SUP-1' }]);
    dbRequest.query.mockResolvedValue({ recordset: [] });
    const postGoodsReceipt = jest.fn().mockRejectedValue(new Error('SapServer unreachable'));

    const result = await markShipmentReceived(1, { postGoodsReceipt });

    expect(result.orderCount).toBe(1);
    expect(result.sapResults).toEqual([{ suggestionId: 1, material: 'MAT1', success: false, error: 'SapServer unreachable' }]);
  });

  // Supplier reference — RM07M-LFSNR must be the SUPPLIER's own reference,
  // not Nexus's internal shipment reference (see postGoodsReceiptToSap's
  // comment in performance.js), so every non-cancelled line must end up
  // with one before anything is written.
  test('rejects with a 400 naming the material when a line has no SupplierReference on file and none was supplied, before writing anything', async () => {
    queueShipmentAndOrders([{ SuggestionId: 1, Material: 'MAT1', OrderQty: 100 }]);

    await expect(markShipmentReceived(1, { receivedBy: 'tester' })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('MAT1'),
    });

    // Only the two lookups ran — no UPDATE was issued once validation failed.
    expect(dbRequest.query).toHaveBeenCalledTimes(2);
  });

  test('accepts a freshly-supplied supplierReferences entry for a line with none on file, and saves it back onto the order', async () => {
    queueShipmentAndOrders([{ SuggestionId: 1, Material: 'MAT1', OrderQty: 100 }]);
    dbRequest.query.mockResolvedValue({ recordset: [] });

    await markShipmentReceived(1, { receivedBy: 'tester', supplierReferences: { 1: 'PAPERWORK-99' } });

    expect(inputCalls('supplierReference')).toEqual(['PAPERWORK-99']);
  });

  test('uses the SupplierReference already on file over a blank/whitespace supplierReferences entry', async () => {
    queueShipmentAndOrders([{ SuggestionId: 1, Material: 'MAT1', OrderQty: 100, SupplierReference: 'SUP-1' }]);
    dbRequest.query.mockResolvedValue({ recordset: [] });

    await markShipmentReceived(1, { receivedBy: 'tester', supplierReferences: { 1: '   ' } });

    expect(inputCalls('supplierReference')).toEqual(['SUP-1']);
  });

  test('rejects with a 400 when a supplierReferences entry is only whitespace and nothing is on file', async () => {
    queueShipmentAndOrders([{ SuggestionId: 1, Material: 'MAT1', OrderQty: 100 }]);

    await expect(markShipmentReceived(1, { supplierReferences: { 1: '   ' } })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('MAT1'),
    });
  });
});

// Inbound Log's "Undo Received" action. Query order inside
// undoShipmentReceived: (1) shipment lookup, (2) Booked/Received linked
// orders, then per order either an UPDATE clearing everything (reversed) or
// an UPDATE stamping just SapGrError (still posted), and finally an UPDATE
// clearing the shipment's ReceivedAtUtc/ReceivedBy — only issued when every
// line was reversed.
describe('undoShipmentReceived', () => {
  function queueShipmentAndOrders(orders, { received = true, cancelled = false } = {}) {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ ShipmentId: 1, ReceivedAtUtc: received ? '2026-08-01T00:00:00Z' : null, CancelledAtUtc: cancelled ? '2026-08-02T00:00:00Z' : null }] })
      .mockResolvedValueOnce({ recordset: orders });
  }

  function inputCalls(name) {
    return dbRequest.input.mock.calls.filter(call => call[0] === name).map(call => call[2]);
  }

  test('rejects with a 404 when the shipment does not exist', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });
    await expect(undoShipmentReceived(999, {})).rejects.toMatchObject({
      statusCode: 404,
      message: expect.stringContaining('Shipment not found'),
    });
  });

  test('rejects with a 400 when the shipment was never marked received', async () => {
    queueShipmentAndOrders([], { received: false });
    await expect(undoShipmentReceived(1, {})).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('has not been marked received'),
    });
  });

  test('rejects with a 400 when the shipment has been cancelled', async () => {
    queueShipmentAndOrders([], { received: true, cancelled: true });
    await expect(undoShipmentReceived(1, {})).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('cancelled'),
    });
  });

  test('clears a line with no SapMaterialDocument straight through with no SAP call', async () => {
    queueShipmentAndOrders([{ SuggestionId: 1, Material: 'MAT1', SapMaterialDocument: null }]);
    dbRequest.query.mockResolvedValue({ recordset: [] });
    const reverseGoodsReceipt = jest.fn();

    const result = await undoShipmentReceived(1, { reverseGoodsReceipt });

    expect(reverseGoodsReceipt).not.toHaveBeenCalled();
    expect(result).toEqual({
      reversedCount: 1, stillPostedCount: 0, shipmentUndone: true,
      sapResults: [{ suggestionId: 1, material: 'MAT1', success: true, skipped: true }],
    });
  });

  test('reverses a posted line via the callback, clears its fields, and un-receives the shipment', async () => {
    queueShipmentAndOrders([{ SuggestionId: 1, Material: 'MAT1', SapMaterialDocument: '5000000001' }]);
    dbRequest.query.mockResolvedValue({ recordset: [] });
    const reverseGoodsReceipt = jest.fn().mockResolvedValue({ success: true });

    const result = await undoShipmentReceived(1, { reverseGoodsReceipt });

    expect(reverseGoodsReceipt).toHaveBeenCalledWith(expect.objectContaining({ SuggestionId: 1, SapMaterialDocument: '5000000001' }));
    expect(result.reversedCount).toBe(1);
    expect(result.shipmentUndone).toBe(true);
    // The clearing UPDATE stamps Status back to 'Ordered' with everything else nulled.
    expect(inputCalls('suggestionId')).toContain(1);
  });

  test('leaves a line whose SAP reversal fails untouched (status/document intact) and does not un-receive the shipment', async () => {
    queueShipmentAndOrders([
      { SuggestionId: 1, Material: 'MAT1', SapMaterialDocument: '5000000001' },
      { SuggestionId: 2, Material: 'MAT2', SapMaterialDocument: '5000000002' },
    ]);
    dbRequest.query.mockResolvedValue({ recordset: [] });
    const reverseGoodsReceipt = jest.fn()
      .mockResolvedValueOnce({ success: false, error: 'Document already reversed.' })
      .mockResolvedValueOnce({ success: true });

    const result = await undoShipmentReceived(1, { reverseGoodsReceipt });

    expect(result.reversedCount).toBe(1);
    expect(result.stillPostedCount).toBe(1);
    expect(result.shipmentUndone).toBe(false); // one line still posted — shipment stays "received"
    expect(result.sapResults).toEqual([
      { suggestionId: 1, material: 'MAT1', success: false, error: 'Document already reversed.' },
      { suggestionId: 2, material: 'MAT2', success: true },
    ]);
    expect(inputCalls('sapGrError')).toContain('Document already reversed.');
  });

  test('skipSap force-clears every line and un-receives the shipment without calling SAP', async () => {
    queueShipmentAndOrders([{ SuggestionId: 1, Material: 'MAT1', SapMaterialDocument: '5000000001' }]);
    dbRequest.query.mockResolvedValue({ recordset: [] });
    const reverseGoodsReceipt = jest.fn();

    const result = await undoShipmentReceived(1, { skipSap: true, reverseGoodsReceipt });

    expect(reverseGoodsReceipt).not.toHaveBeenCalled();
    expect(result.reversedCount).toBe(1);
    expect(result.shipmentUndone).toBe(true);
  });

  test('treats a thrown reverseGoodsReceipt as a failure rather than aborting the undo', async () => {
    queueShipmentAndOrders([{ SuggestionId: 1, Material: 'MAT1', SapMaterialDocument: '5000000001' }]);
    dbRequest.query.mockResolvedValue({ recordset: [] });
    const reverseGoodsReceipt = jest.fn().mockRejectedValue(new Error('SapServer unreachable'));

    const result = await undoShipmentReceived(1, { reverseGoodsReceipt });

    expect(result.stillPostedCount).toBe(1);
    expect(result.shipmentUndone).toBe(false);
    expect(result.sapResults).toEqual([{ suggestionId: 1, material: 'MAT1', success: false, error: 'SapServer unreachable' }]);
  });
});

// assertOrderEditable's completed-order lock — Tracked Orders' general edit
// paths (row Save, Delete, Assign Shipment) all reject once an order's
// Status is 'Received' (or the retired 'Booked'), so the UI's "no edits on
// a completed row" rule can't be bypassed via a direct API call. Each
// guarded function does its own SELECT Status lookup first, so the lock
// check is always the first query.
describe('assertOrderEditable (updateOrderSuggestionStatus / deleteOrderSuggestion / assignOrderShipment)', () => {
  test('updateOrderSuggestionStatus rejects with 409 when the order is already Received', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ Status: 'Received' }] });

    await expect(updateOrderSuggestionStatus(1, { status: 'Ordered' })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('Undo Received'),
    });
    expect(dbRequest.query).toHaveBeenCalledTimes(1); // never reaches the UPDATE
  });

  test('updateOrderSuggestionStatus rejects with 409 when the order is still the retired Booked status', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ Status: 'Booked' }] });

    await expect(updateOrderSuggestionStatus(1, { status: 'Ordered' })).rejects.toMatchObject({ statusCode: 409 });
  });

  test('updateOrderSuggestionStatus rejects with 404 when the order does not exist', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });

    await expect(updateOrderSuggestionStatus(999, { status: 'Ordered' })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('updateOrderSuggestionStatus proceeds normally for a not-yet-received order', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ Status: 'Ordered' }] })
      .mockResolvedValueOnce({ recordset: [] });

    await expect(updateOrderSuggestionStatus(1, { status: 'Received' })).resolves.toBeUndefined();
    expect(dbRequest.query).toHaveBeenCalledTimes(2);
  });

  test('deleteOrderSuggestion rejects with 409 when the order is already Received', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ Status: 'Received' }] });

    await expect(deleteOrderSuggestion(1)).rejects.toMatchObject({ statusCode: 409 });
    expect(dbRequest.query).toHaveBeenCalledTimes(1); // never reaches the DELETE
  });

  test('deleteOrderSuggestion proceeds normally for a not-yet-received order', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ Status: 'Accepted' }] })
      .mockResolvedValueOnce({ recordset: [{ SuggestionId: 1 }] });

    await expect(deleteOrderSuggestion(1)).resolves.toBeUndefined();
  });

  test('assignOrderShipment rejects with 409 when the order is already Received, before checking the target shipment', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ Status: 'Received' }] });

    await expect(assignOrderShipment(1, 5)).rejects.toMatchObject({ statusCode: 409 });
    expect(dbRequest.query).toHaveBeenCalledTimes(1);
  });

  test('assignOrderShipment proceeds normally for a not-yet-received order', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ Status: 'Ordered' }] })
      .mockResolvedValueOnce({ recordset: [{ CancelledAtUtc: null }] })
      .mockResolvedValueOnce({ recordset: [] });

    await expect(assignOrderShipment(1, 5)).resolves.toBeUndefined();
  });
});

// The one edit deliberately NOT covered by assertOrderEditable's lock — see
// updateOrderSuggestionPoItem's comment in performancesql.js for why it
// stays usable on an already-Received line.
describe('updateOrderSuggestionPoItem', () => {
  test('sets PoItemNumber with a single query and no completed-order lock check', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });

    await updateOrderSuggestionPoItem(1, '00010');

    expect(dbRequest.query).toHaveBeenCalledTimes(1);
    expect(dbRequest.input.mock.calls.filter(call => call[0] === 'poItemNumber').map(call => call[2])).toEqual(['00010']);
  });
});

// ScheduleAgreementItem — the missing piece Vendor Master Data needed
// alongside the existing ScheduleAgreement field (see this column's own
// comment in the migration) so a Tracked Orders line can be assigned
// straight to the agreement instead of raising a PO.
describe('addVendorMaterial / updateVendorMaterial — scheduleAgreementItem', () => {
  test('addVendorMaterial passes scheduleAgreementItem through to the INSERT', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ VendorMaterialId: 1 }] });

    await addVendorMaterial(1, { material: 'MAT1', scheduleAgreement: '4600012345', scheduleAgreementItem: '00010' });

    expect(dbRequest.input.mock.calls.filter(call => call[0] === 'scheduleAgreementItem').map(call => call[2])).toEqual(['00010']);
  });

  test('addVendorMaterial defaults scheduleAgreementItem to null when omitted', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ VendorMaterialId: 1 }] });

    await addVendorMaterial(1, { material: 'MAT1' });

    expect(dbRequest.input.mock.calls.filter(call => call[0] === 'scheduleAgreementItem').map(call => call[2])).toEqual([null]);
  });

  test('updateVendorMaterial passes scheduleAgreementItem through to the UPDATE', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });

    await updateVendorMaterial(1, { scheduleAgreement: '4600012345', scheduleAgreementItem: '00020' });

    expect(dbRequest.input.mock.calls.filter(call => call[0] === 'scheduleAgreementItem').map(call => call[2])).toEqual(['00020']);
  });
});

// Manual Inbound Shipment cargo items (dbo.ManualInboundItem) — lets an
// operator record material + quantity actually on a manual shipment. Query
// order inside addManualInboundItem: (1) IsManual lookup, (2) INSERT.
describe('addManualInboundItem', () => {
  test('rejects with a 404 when the shipment does not exist', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });

    await expect(addManualInboundItem(999, { material: 'T1700-16', quantity: 103 })).rejects.toMatchObject({
      statusCode: 404,
      message: expect.stringContaining('Shipment not found'),
    });
    expect(dbRequest.query).toHaveBeenCalledTimes(1);
  });

  test('rejects with a 400 when the shipment is not manual, before inserting anything', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ IsManual: false }] });

    await expect(addManualInboundItem(1, { material: 'T1700-16', quantity: 103 })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('manual shipment'),
    });
    expect(dbRequest.query).toHaveBeenCalledTimes(1);
  });

  test('rejects with a 400 when quantity is not greater than 0', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ IsManual: true }] });

    await expect(addManualInboundItem(1, { material: 'T1700-16', quantity: 0 })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Quantity'),
    });
  });

  test('rejects with a 400 when neither material nor description is given', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ IsManual: true }] });

    await expect(addManualInboundItem(1, { quantity: 103 })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('material or a description'),
    });
  });

  test('inserts the item on a manual shipment with valid material + quantity', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ IsManual: true }] })
      .mockResolvedValueOnce({ recordset: [] });

    await addManualInboundItem(1, { material: 'T1700-16', quantity: '103', unitOfMeasure: 'M', createdBy: 'tester' });

    expect(dbRequest.query).toHaveBeenCalledTimes(2);
    const inputCalls = (name) => dbRequest.input.mock.calls.filter(call => call[0] === name).map(call => call[2]);
    expect(inputCalls('material')).toContain('T1700-16');
    expect(inputCalls('quantity')).toContain(103);
    expect(inputCalls('unitOfMeasure')).toContain('M');
  });
});

describe('removeManualInboundItem', () => {
  test('rejects with a 404 when the item does not exist (or was already removed)', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });

    await expect(removeManualInboundItem(999)).rejects.toMatchObject({
      statusCode: 404,
      message: expect.stringContaining('Item not found'),
    });
    expect(dbRequest.query).toHaveBeenCalledTimes(1);
  });

  test('soft-deletes an existing item', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ ItemId: 1 }] })
      .mockResolvedValueOnce({ recordset: [] });

    await removeManualInboundItem(1);

    expect(dbRequest.query).toHaveBeenCalledTimes(2);
  });
});

// upsertForecastAccuracyLog's k=0 (current month) row must freeze at whatever it was on the
// first successful sync after the month started, rather than drifting all month — see the
// function's own header comment. Verified here by proving the *code path* taken: k=0 goes
// through upsertBatch's insertOnly mode (INSERT only, no UPDATE query issued for that batch),
// while k=1..12 and ActualQty go through the normal upsert (UPDATE then INSERT). A mocked-mssql
// unit test can't prove the real "existing row is left alone" behavior end-to-end — that needs
// the SQL Server-gated integration suite (see performance.orderSuggestions.integration.test.js
// or add a case there) calling this twice in the same month with a different forecast value.
describe('upsertForecastAccuracyLog', () => {
  beforeEach(() => {
    dbRequest.query.mockResolvedValue({ recordset: [] });
  });

  test('writes the current month (k=0) insert-only, but freely upserts future months (k=1..12) and ActualQty', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-15T00:00:00Z'));

    await upsertForecastAccuracyLog([
      {
        material: 'MAT1', plant: '1000',
        demandForecast: Array(13).fill(10),
        predictedUsage: Array(13).fill(5),
        consumptionHistory: Array(13).fill(3),
      },
    ]);

    const queries = dbRequest.query.mock.calls.map(call => call[0]);
    // Order: futureMonthRows (UPDATE, INSERT) → currentMonthRows insertOnly (INSERT only) → actualRows (UPDATE, INSERT)
    expect(queries).toHaveLength(5);
    expect(queries[0]).toMatch(/UPDATE t SET/);
    expect(queries[1]).toMatch(/INSERT INTO log\.ForecastAccuracyLog/);
    expect(queries[2]).toMatch(/INSERT INTO log\.ForecastAccuracyLog/);
    expect(queries[3]).toMatch(/UPDATE t SET/);
    expect(queries[4]).toMatch(/INSERT INTO log\.ForecastAccuracyLog/);

    jest.useRealTimers();
  });

  test('the current-month (k=0) row targets TargetMonth = first day of the current UTC month', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-15T00:00:00Z'));

    // Sentinel at index 0 (k=0, the current month) — every other k gets a plain value, so this
    // appears exactly once across all input() calls, letting us locate its row unambiguously.
    const demandForecast = Array(13).fill(10);
    demandForecast[0] = -999;

    await upsertForecastAccuracyLog([
      { material: 'MAT1', plant: '1000', demandForecast, predictedUsage: Array(13).fill(5), consumptionHistory: [] },
    ]);

    const inputCalls = dbRequest.input.mock.calls;
    const sentinelCalls = inputCalls.filter(call => call[2] === -999);
    expect(sentinelCalls).toHaveLength(1);

    // Columns are bound in order (Material, Plant, TargetMonth, SapDemandQty, PredictedQty) per
    // row, so TargetMonth is the input() call immediately before the SapDemandQty sentinel.
    const sentinelIdx = inputCalls.indexOf(sentinelCalls[0]);
    expect(inputCalls[sentinelIdx - 1][2]).toEqual(new Date(Date.UTC(2026, 7, 1)));

    jest.useRealTimers();
  });
});
