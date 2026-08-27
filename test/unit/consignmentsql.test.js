// routes/consignmentsql.js is the DB layer for the Vendor Consignment
// Tracker — previously only exercised indirectly through routes/
// consignment.js's mocks (see CLAUDE.md). This suite tests it directly
// against a mocked mssql pool/transaction, focused on its real logic:
// buildAllocationProposal's greedy FEFO/FIFO walk (pure function, no DB),
// the transactional functions' commit/rollback behavior and status guards
// (createDeclaration, setDeclarationLines, confirmDeclaration,
// cancelDeclaration), upsertConsignmentDeliveriesFromSap's dedup-by-
// (MaterialDocument,MaterialDocItem), replaceConsignmentStockSnapshot's
// truncate-then-batch-insert, and a representative sample of the simpler
// vendor/delivery CRUD reads.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';

const { sqlModule, pool, request: dbRequest, connect, transaction, Transaction } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let db;

beforeAll(async () => {
  db = await import('../../routes/consignmentsql.js');
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect, transaction, Transaction });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('buildAllocationProposal (pure, no DB)', () => {
  test('allocates greedily against the given order until qtyToDeclare is exhausted', () => {
    const rows = [
      { DeliveryId: 1, Material: 'M1', RemainingQty: 50, InvoiceNumber: 'INV1', ExpiryDate: '2026-06-01', DocumentDate: '2026-01-01' },
      { DeliveryId: 2, Material: 'M1', RemainingQty: 100, InvoiceNumber: 'INV2', ExpiryDate: '2026-07-01', DocumentDate: '2026-01-02' },
    ];
    const result = db.buildAllocationProposal(rows, 80);
    expect(result.lines).toEqual([
      expect.objectContaining({ deliveryId: 1, qtyAllocated: 50, remainingBeforeAllocation: 50 }),
      expect.objectContaining({ deliveryId: 2, qtyAllocated: 30, remainingBeforeAllocation: 100 }),
    ]);
    expect(result.unallocatedQty).toBe(0);
  });

  test('reports unallocatedQty when total remaining stock is insufficient', () => {
    const rows = [{ DeliveryId: 1, Material: 'M1', RemainingQty: 20 }];
    const result = db.buildAllocationProposal(rows, 50);
    expect(result.lines).toEqual([expect.objectContaining({ deliveryId: 1, qtyAllocated: 20 })]);
    expect(result.unallocatedQty).toBe(30);
  });

  test('skips delivery lines with zero or negative RemainingQty', () => {
    const rows = [
      { DeliveryId: 1, Material: 'M1', RemainingQty: 0 },
      { DeliveryId: 2, Material: 'M1', RemainingQty: -5 },
      { DeliveryId: 3, Material: 'M1', RemainingQty: 10 },
    ];
    const result = db.buildAllocationProposal(rows, 10);
    expect(result.lines).toEqual([expect.objectContaining({ deliveryId: 3, qtyAllocated: 10 })]);
  });

  test('stops walking further delivery lines once qtyToDeclare is fully allocated', () => {
    const rows = [
      { DeliveryId: 1, Material: 'M1', RemainingQty: 100 },
      { DeliveryId: 2, Material: 'M1', RemainingQty: 100 },
    ];
    const result = db.buildAllocationProposal(rows, 10);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].deliveryId).toBe(1);
  });

  test('rounds allocated quantities to 3 decimal places', () => {
    const rows = [{ DeliveryId: 1, Material: 'M1', RemainingQty: 10 }];
    const result = db.buildAllocationProposal(rows, 3.14159265);
    expect(result.lines[0].qtyAllocated).toBe(3.142); // Math.round(3141.59265) / 1000
  });

  test('an empty delivery list allocates nothing and reports the full amount unallocated', () => {
    const result = db.buildAllocationProposal([], 25);
    expect(result.lines).toEqual([]);
    expect(result.unallocatedQty).toBe(25);
  });
});

describe('listConsignmentVendors / getConsignmentVendor', () => {
  test('listConsignmentVendors returns the joined recordset', async () => {
    queueResults({ recordset: [{ VendorId: 1, VendorName: 'Chemours' }] });
    const rows = await db.listConsignmentVendors();
    expect(rows).toEqual([{ VendorId: 1, VendorName: 'Chemours' }]);
  });

  test('getConsignmentVendor returns null when the vendor does not exist', async () => {
    queueResults({ recordset: [] });
    const vendor = await db.getConsignmentVendor(999);
    expect(vendor).toBeNull();
  });

  test('getConsignmentVendor returns the row when found', async () => {
    queueResults({ recordset: [{ VendorId: 1, VendorName: 'Chemours' }] });
    const vendor = await db.getConsignmentVendor(1);
    expect(vendor).toEqual({ VendorId: 1, VendorName: 'Chemours' });
  });
});

describe('upsertConsignmentVendorConfig', () => {
  test('inserts when no config row exists yet', async () => {
    queueResults(
      { recordset: [] },                            // exists check: not found
      { recordset: [] },                             // the INSERT
      { recordset: [{ VendorId: 1, Active: 1 }] },    // getConsignmentVendor's re-read
    );
    const result = await db.upsertConsignmentVendorConfig(1, { defaultAllocationMethod: 'FEFO' }, 'j.smith');
    expect(dbRequest.query.mock.calls[1][0]).toContain('INSERT INTO log.ConsignmentVendorConfig');
    expect(result).toEqual({ VendorId: 1, Active: 1 });
  });

  test('updates when a config row already exists', async () => {
    queueResults(
      { recordset: [{ 1: 1 }] },                     // exists check: found
      { recordset: [] },                              // the UPDATE
      { recordset: [{ VendorId: 1, Active: 0 }] },     // getConsignmentVendor's re-read
    );
    await db.upsertConsignmentVendorConfig(1, { active: false }, 'j.smith');
    expect(dbRequest.query.mock.calls[1][0]).toContain('UPDATE log.ConsignmentVendorConfig');
  });

  test('defaults active to true when not specified', async () => {
    queueResults({ recordset: [] }, { recordset: [] }, { recordset: [] });
    await db.upsertConsignmentVendorConfig(1, {}, 'j.smith');
    expect(dbRequest.input).toHaveBeenCalledWith('active', expect.anything(), true);
  });
});

describe('upsertConsignmentDeliveriesFromSap', () => {
  test('does nothing and returns inserted:0 for an empty rows array', async () => {
    const result = await db.upsertConsignmentDeliveriesFromSap(1, []);
    expect(result).toEqual({ inserted: 0 });
    expect(Transaction).not.toHaveBeenCalled();
  });

  test('dedupes rows sharing the same (MaterialDocument, MaterialDocItem) before inserting', async () => {
    queueResults({ rowsAffected: [1] }, { rowsAffected: [0] }); // one INSERT + its backfill UPDATE
    const result = await db.upsertConsignmentDeliveriesFromSap(1, [
      { material: 'M1', materialDocument: 'DOC1', materialDocItem: '0001', quantity: 10 },
      { material: 'M1', materialDocument: 'DOC1', materialDocItem: '0001', quantity: 10 }, // exact duplicate key
    ]);
    expect(dbRequest.query).toHaveBeenCalledTimes(2);
    expect(dbRequest.query.mock.calls[0][0]).toContain('INSERT INTO log.ConsignmentDelivery');
    expect(dbRequest.query.mock.calls[1][0]).toContain('UPDATE log.ConsignmentDelivery');
    expect(result).toEqual({ inserted: 1 });
  });

  test('backfills InvoiceNumber/ReversalOfMaterialDocument on an already-existing row that is still missing them', async () => {
    queueResults({ rowsAffected: [0] }, { rowsAffected: [1] }); // INSERT is a no-op (row exists), UPDATE backfills
    await db.upsertConsignmentDeliveriesFromSap(1, [
      { material: 'M1', materialDocument: 'DOC1', materialDocItem: '0001', quantity: 10, invoiceNumber: 'E0269', reversalOfMaterialDocument: 'DOC0', reversalOfMaterialDocItem: '0001' },
    ]);
    expect(dbRequest.input).toHaveBeenCalledWith('invoiceNumber', expect.anything(), 'E0269');
    expect(dbRequest.input).toHaveBeenCalledWith('reversalOfMaterialDocument', expect.anything(), 'DOC0');
    const updateCall = dbRequest.query.mock.calls[1][0];
    expect(updateCall).toContain('COALESCE(NULLIF(InvoiceNumber');
  });

  test('commits the transaction after a successful batch', async () => {
    queueResults({ rowsAffected: [1] });
    await db.upsertConsignmentDeliveriesFromSap(1, [{ material: 'M1', materialDocument: 'DOC1', materialDocItem: '0001', quantity: 10 }]);
    expect(transaction.begin).toHaveBeenCalled();
    expect(transaction.commit).toHaveBeenCalled();
    expect(transaction.rollback).not.toHaveBeenCalled();
  });

  test('rolls back and rethrows if a row insert fails mid-batch', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('constraint violation'));
    await expect(
      db.upsertConsignmentDeliveriesFromSap(1, [{ material: 'M1', materialDocument: 'DOC1', materialDocItem: '0001', quantity: 10 }]),
    ).rejects.toThrow('constraint violation');
    expect(transaction.rollback).toHaveBeenCalled();
    expect(transaction.commit).not.toHaveBeenCalled();
  });

  test('counts rowsAffected as 0 (not inserted) when the WHERE NOT EXISTS guard skips a real duplicate', async () => {
    queueResults({ rowsAffected: [0] }); // simulates the row already existing in the real table
    const result = await db.upsertConsignmentDeliveriesFromSap(1, [{ material: 'M1', materialDocument: 'DOC1', materialDocItem: '0001', quantity: 10 }]);
    expect(result).toEqual({ inserted: 0 });
  });
});

describe('computeReversalCancellations (pure, no DB)', () => {
  test('leaves a standalone row (no reversal chain) untouched', () => {
    const rows = [{ DeliveryId: 1, MaterialDocument: 'A', MaterialDocItem: '0001', Quantity: 100, RemainingQty: 100 }];
    const { toZero, needsReview } = db.computeReversalCancellations(rows);
    expect(toZero).toEqual([]);
    expect(needsReview).toEqual([]);
  });

  test('a simple reversal pair (root cancelled once) zeroes both rows', () => {
    // B reverses A — chain length 2 (even) — root ends up cancelled.
    const rows = [
      { DeliveryId: 1, MaterialDocument: 'A', MaterialDocItem: '0001', Quantity: 100, RemainingQty: 100, ReversalOfMaterialDocument: null, ReversalOfMaterialDocItem: null },
      { DeliveryId: 2, MaterialDocument: 'B', MaterialDocItem: '0001', Quantity: -100, RemainingQty: -100, ReversalOfMaterialDocument: 'A', ReversalOfMaterialDocItem: '0001' },
    ];
    const { toZero, needsReview } = db.computeReversalCancellations(rows);
    expect(toZero.map(r => r.DeliveryId).sort()).toEqual([1, 2]);
    expect(needsReview).toEqual([]);
  });

  test('a cancel-of-a-cancel chain (root restored) keeps the ROOT live and zeroes the two corrections', () => {
    // Confirmed for real: Raaj Ratna 5005174284 (root, GR) -> 5005203102
    // (MBST, cancels root) -> 5005203103 (MBST, cancels THAT cancellation).
    // Chain length 3 (odd) — root ends up live again.
    const rows = [
      { DeliveryId: 1, MaterialDocument: 'ROOT', MaterialDocItem: '0002', Quantity: 1110.8, RemainingQty: 1110.8, ReversalOfMaterialDocument: null, ReversalOfMaterialDocItem: null },
      { DeliveryId: 2, MaterialDocument: 'MID', MaterialDocItem: '0001', Quantity: -1110.8, RemainingQty: -1110.8, ReversalOfMaterialDocument: 'ROOT', ReversalOfMaterialDocItem: '0002' },
      { DeliveryId: 3, MaterialDocument: 'LAST', MaterialDocItem: '0001', Quantity: 1110.8, RemainingQty: 1110.8, ReversalOfMaterialDocument: 'MID', ReversalOfMaterialDocItem: '0001' },
    ];
    const { toZero, needsReview } = db.computeReversalCancellations(rows);
    expect(toZero.map(r => r.DeliveryId).sort()).toEqual([2, 3]); // ROOT (1) stays live
    expect(needsReview).toEqual([]);
  });

  test('reports (does not silently zero) a chain member whose RemainingQty already differs from Quantity', () => {
    const rows = [
      { DeliveryId: 1, MaterialDocument: 'A', MaterialDocItem: '0001', Quantity: 100, RemainingQty: 100, ReversalOfMaterialDocument: null, ReversalOfMaterialDocItem: null },
      // B reverses A, but B's RemainingQty has already been reduced — a real declaration touched it.
      { DeliveryId: 2, MaterialDocument: 'B', MaterialDocItem: '0001', Quantity: -100, RemainingQty: -100, ReversalOfMaterialDocument: 'A', ReversalOfMaterialDocItem: '0001' },
      { DeliveryId: 3, MaterialDocument: 'C', MaterialDocItem: '0001', Quantity: 100, RemainingQty: 40, ReversalOfMaterialDocument: 'B', ReversalOfMaterialDocItem: '0001' },
    ];
    const { toZero, needsReview } = db.computeReversalCancellations(rows);
    // Chain length 3 -> root (A) live, B and C are the non-root members.
    // B is untouched (safe to zero); C's RemainingQty (40) already differs
    // from its Quantity (100), so it's flagged instead of overwritten.
    expect(toZero.map(r => r.DeliveryId)).toEqual([2]);
    expect(needsReview).toHaveLength(1);
    expect(needsReview[0].row.DeliveryId).toBe(3);
  });

  test('flags an anomaly when more than one document reverses the same target', () => {
    const rows = [
      { DeliveryId: 1, MaterialDocument: 'A', MaterialDocItem: '0001', Quantity: 100, RemainingQty: 100, ReversalOfMaterialDocument: null, ReversalOfMaterialDocItem: null },
      { DeliveryId: 2, MaterialDocument: 'B', MaterialDocItem: '0001', Quantity: -100, RemainingQty: -100, ReversalOfMaterialDocument: 'A', ReversalOfMaterialDocItem: '0001' },
      { DeliveryId: 3, MaterialDocument: 'C', MaterialDocItem: '0001', Quantity: -100, RemainingQty: -100, ReversalOfMaterialDocument: 'A', ReversalOfMaterialDocItem: '0001' },
    ];
    const { needsReview } = db.computeReversalCancellations(rows);
    expect(needsReview.some(n => n.row.DeliveryId === 3 && n.reason.includes('multiple documents'))).toBe(true);
  });

  test('a reversal whose target is outside the given row set is treated as its own chain root', () => {
    // ReversalOfMaterialDocument points at something not in `rows` at all —
    // can't walk further back, so this row is its own root and, alone,
    // has nothing reversing it — left untouched.
    const rows = [
      { DeliveryId: 1, MaterialDocument: 'B', MaterialDocItem: '0001', Quantity: -100, RemainingQty: -100, ReversalOfMaterialDocument: 'OUTSIDE', ReversalOfMaterialDocItem: '0001' },
    ];
    const { toZero, needsReview } = db.computeReversalCancellations(rows);
    expect(toZero).toEqual([]);
    expect(needsReview).toEqual([]);
  });
});

describe('applyReversalCancellations', () => {
  test('zeroes RemainingQty only for rows computeReversalCancellations says are safe to zero', async () => {
    queueResults(
      { recordset: [
        { DeliveryId: 1, Material: 'M1', MaterialDocument: 'A', MaterialDocItem: '0001', Quantity: 100, RemainingQty: 100, ReversalOfMaterialDocument: null, ReversalOfMaterialDocItem: null },
        { DeliveryId: 2, Material: 'M1', MaterialDocument: 'B', MaterialDocItem: '0001', Quantity: -100, RemainingQty: -100, ReversalOfMaterialDocument: 'A', ReversalOfMaterialDocItem: '0001' },
      ] },
      { rowsAffected: [1] }, // UPDATE for DeliveryId 1
      { rowsAffected: [1] }, // UPDATE for DeliveryId 2
    );
    const result = await db.applyReversalCancellations(1);
    expect(result.zeroed.map(z => z.deliveryId).sort()).toEqual([1, 2]);
    expect(result.needsReview).toEqual([]);
    expect(dbRequest.query.mock.calls[1][0]).toContain('SET RemainingQty = 0');
  });
});

describe('computeReassignmentPlan (pure, no DB)', () => {
  test('reassigns entirely to a single open FEFO line when it fully covers the quantity', () => {
    const cancelledLines = [{ declarationLineId: 1, declarationId: 1, cancelledDeliveryId: 99, material: 'M1', qtyAllocated: 50 }];
    const openRows = [
      { DeliveryId: 10, Material: 'M1', RemainingQty: 200, ExpiryDate: '2026-06-01', DocumentDate: '2026-01-01' },
      { DeliveryId: 11, Material: 'M1', RemainingQty: 200, ExpiryDate: '2026-07-01', DocumentDate: '2026-01-02' },
    ];
    const plan = db.computeReassignmentPlan(cancelledLines, openRows);
    expect(plan).toEqual([
      expect.objectContaining({ declarationLineId: 1, totalQty: 50, shortfall: 0, splits: [{ deliveryId: 10, qty: 50 }] }),
    ]);
  });

  test('splits across multiple FEFO lines when the earliest one alone is not enough', () => {
    const cancelledLines = [{ declarationLineId: 1, declarationId: 1, cancelledDeliveryId: 99, material: 'M1', qtyAllocated: 150 }];
    const openRows = [
      { DeliveryId: 10, Material: 'M1', RemainingQty: 100, ExpiryDate: '2026-06-01', DocumentDate: '2026-01-01' },
      { DeliveryId: 11, Material: 'M1', RemainingQty: 100, ExpiryDate: '2026-07-01', DocumentDate: '2026-01-02' },
    ];
    const plan = db.computeReassignmentPlan(cancelledLines, openRows);
    expect(plan[0].splits).toEqual([{ deliveryId: 10, qty: 100 }, { deliveryId: 11, qty: 50 }]);
    expect(plan[0].shortfall).toBe(0);
  });

  test('reports a shortfall (does not over-allocate) when open stock runs out', () => {
    const cancelledLines = [{ declarationLineId: 1, declarationId: 1, cancelledDeliveryId: 99, material: 'M1', qtyAllocated: 150 }];
    const openRows = [{ DeliveryId: 10, Material: 'M1', RemainingQty: 40, ExpiryDate: '2026-06-01', DocumentDate: '2026-01-01' }];
    const plan = db.computeReassignmentPlan(cancelledLines, openRows);
    expect(plan[0].splits).toEqual([{ deliveryId: 10, qty: 40 }]);
    expect(plan[0].shortfall).toBe(110);
  });

  test('shares one mutable pool across multiple cancelled lines for the same material, in (declarationId, declarationLineId) order', () => {
    const cancelledLines = [
      { declarationLineId: 5, declarationId: 2, cancelledDeliveryId: 98, material: 'M1', qtyAllocated: 60 },
      { declarationLineId: 1, declarationId: 1, cancelledDeliveryId: 99, material: 'M1', qtyAllocated: 60 },
    ];
    const openRows = [{ DeliveryId: 10, Material: 'M1', RemainingQty: 100, ExpiryDate: '2026-06-01', DocumentDate: '2026-01-01' }];
    const plan = db.computeReassignmentPlan(cancelledLines, openRows);
    // declarationId 1 (line 1) is processed first despite appearing second in the input.
    expect(plan[0]).toEqual(expect.objectContaining({ declarationLineId: 1, splits: [{ deliveryId: 10, qty: 60 }], shortfall: 0 }));
    // declarationId 2 (line 5) only sees the 40 left over after line 1 already claimed 60.
    expect(plan[1]).toEqual(expect.objectContaining({ declarationLineId: 5, splits: [{ deliveryId: 10, qty: 40 }], shortfall: 20 }));
  });

  test('never touches open rows for a different material', () => {
    const cancelledLines = [{ declarationLineId: 1, declarationId: 1, cancelledDeliveryId: 99, material: 'M1', qtyAllocated: 10 }];
    const openRows = [{ DeliveryId: 10, Material: 'M2', RemainingQty: 100, ExpiryDate: '2026-06-01', DocumentDate: '2026-01-01' }];
    const plan = db.computeReassignmentPlan(cancelledLines, openRows);
    expect(plan[0].splits).toEqual([]);
    expect(plan[0].shortfall).toBe(10);
  });
});

describe('buildReassignmentPlanForVendor', () => {
  test('returns [] when nothing needs reassigning', async () => {
    queueResults({ recordset: [{ DeliveryId: 1, Material: 'M1', MaterialDocument: 'A', MaterialDocItem: '0001', Quantity: 100, RemainingQty: 100, ReversalOfMaterialDocument: null, ReversalOfMaterialDocItem: null }] });
    const plan = await db.buildReassignmentPlanForVendor(1);
    expect(plan).toEqual([]);
  });

  test('builds a plan from declaration lines pointing at a cancelled delivery', async () => {
    queueResults(
      { recordset: [
        { DeliveryId: 1, Material: 'M1', MaterialDocument: 'A', MaterialDocItem: '0001', Quantity: 100, RemainingQty: 0, ReversalOfMaterialDocument: null, ReversalOfMaterialDocItem: null },
        { DeliveryId: 2, Material: 'M1', MaterialDocument: 'B', MaterialDocItem: '0001', Quantity: -100, RemainingQty: -100, ReversalOfMaterialDocument: 'A', ReversalOfMaterialDocItem: '0001' },
      ] },
      { recordset: [{ DeclarationLineId: 7, DeclarationId: 3, CancelledDeliveryId: 1, Material: 'M1', QtyAllocated: 100 }] },
      { recordset: [{ DeliveryId: 20, Material: 'M1', RemainingQty: 150, ExpiryDate: '2026-06-01', DocumentDate: '2026-01-01' }] },
    );
    const plan = await db.buildReassignmentPlanForVendor(1);
    expect(plan).toEqual([
      expect.objectContaining({ declarationLineId: 7, declarationId: 3, cancelledDeliveryId: 1, totalQty: 100, splits: [{ deliveryId: 20, qty: 100 }], shortfall: 0 }),
    ]);
  });
});

describe('applyReassignmentPlan', () => {
  test('re-points DeliveryId in place for a single-split item and decrements the target', async () => {
    queueResults(
      { rowsAffected: [1] }, // UPDATE ConsignmentDeclarationLine.DeliveryId
      { rowsAffected: [1] }, // UPDATE target RemainingQty
    );
    const plan = [{ declarationLineId: 7, declarationId: 3, material: 'M1', cancelledDeliveryId: 1, totalQty: 100, splits: [{ deliveryId: 20, qty: 100 }], shortfall: 0 }];
    const result = await db.applyReassignmentPlan(plan);
    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    expect(dbRequest.query.mock.calls[0][0]).toContain('UPDATE log.ConsignmentDeclarationLine SET DeliveryId');
    expect(dbRequest.query.mock.calls[1][0]).toContain('UPDATE log.ConsignmentDelivery SET RemainingQty = RemainingQty - @qty');
  });

  test('replaces the line with one row per split for a multi-split item', async () => {
    queueResults(
      { rowsAffected: [1] }, // DELETE original line
      { rowsAffected: [1] }, // INSERT split 1
      { rowsAffected: [1] }, // INSERT split 2
      { rowsAffected: [1] }, // UPDATE target 1 RemainingQty
      { rowsAffected: [1] }, // UPDATE target 2 RemainingQty
    );
    const plan = [{ declarationLineId: 7, declarationId: 3, material: 'M1', cancelledDeliveryId: 1, totalQty: 100, splits: [{ deliveryId: 20, qty: 60 }, { deliveryId: 21, qty: 40 }], shortfall: 0 }];
    const result = await db.applyReassignmentPlan(plan);
    expect(result.applied).toHaveLength(1);
    expect(dbRequest.query.mock.calls[0][0]).toContain('DELETE FROM log.ConsignmentDeclarationLine');
    expect(dbRequest.query.mock.calls[1][0]).toContain('INSERT INTO log.ConsignmentDeclarationLine');
    expect(dbRequest.query.mock.calls[2][0]).toContain('INSERT INTO log.ConsignmentDeclarationLine');
  });

  test('skips (does not write) an item with a shortfall', async () => {
    const plan = [{ declarationLineId: 7, declarationId: 3, material: 'M1', cancelledDeliveryId: 1, totalQty: 100, splits: [{ deliveryId: 20, qty: 40 }], shortfall: 60 }];
    const result = await db.applyReassignmentPlan(plan);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(plan);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('rolls back and rethrows if a write fails mid-item', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('constraint violation'));
    const plan = [{ declarationLineId: 7, declarationId: 3, material: 'M1', cancelledDeliveryId: 1, totalQty: 100, splits: [{ deliveryId: 20, qty: 100 }], shortfall: 0 }];
    await expect(db.applyReassignmentPlan(plan)).rejects.toThrow('constraint violation');
    expect(transaction.rollback).toHaveBeenCalled();
  });
});

describe('replaceConsignmentStockSnapshot', () => {
  test('truncates first, then inserts a UNION ALL batch, and reports the material count', async () => {
    queueResults(
      { recordset: [] }, // TRUNCATE
      { recordset: [] }, // the batch INSERT
    );
    const result = await db.replaceConsignmentStockSnapshot({ M1: 10, M2: 20 });
    expect(dbRequest.query.mock.calls[0][0]).toContain('TRUNCATE TABLE');
    expect(dbRequest.query.mock.calls[1][0]).toContain('UNION ALL');
    expect(result.materialCount).toBe(2);
  });

  test('truncates and returns materialCount:0 for an empty snapshot, without a second query', async () => {
    queueResults({ recordset: [] }); // TRUNCATE only
    const result = await db.replaceConsignmentStockSnapshot({});
    expect(dbRequest.query).toHaveBeenCalledTimes(1);
    expect(result.materialCount).toBe(0);
  });
});

describe('getConsignmentStockSnapshot', () => {
  test('maps the recordset into a { material: qty } object with numeric values', async () => {
    queueResults({ recordset: [{ Material: 'M1', Qty: '10.500' }, { Material: 'M2', Qty: 5 }] });
    const result = await db.getConsignmentStockSnapshot();
    expect(result).toEqual({ M1: 10.5, M2: 5 });
  });
});

describe('createDeclaration', () => {
  test('sums qtyAllocated across lines into TotalQty and commits', async () => {
    queueResults(
      { recordset: [{ DeclarationId: 7 }] }, // header INSERT
      { recordset: [] }, // line 1 INSERT
      { recordset: [] }, // line 2 INSERT
    );
    const declarationId = await db.createDeclaration(1, 'FEFO', [
      { deliveryId: 1, material: 'M1', qtyAllocated: 10 },
      { deliveryId: 2, material: 'M1', qtyAllocated: 5 },
    ], 'j.smith');
    expect(declarationId).toBe(7);
    expect(dbRequest.input).toHaveBeenCalledWith('totalQty', expect.anything(), 15);
    expect(transaction.commit).toHaveBeenCalled();
  });

  test('rolls back and rethrows if a line insert fails', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ DeclarationId: 7 }] })
      .mockRejectedValueOnce(new Error('FK violation'));
    await expect(db.createDeclaration(1, 'FEFO', [{ deliveryId: 1, material: 'M1', qtyAllocated: 10 }], 'j.smith'))
      .rejects.toThrow('FK violation');
    expect(transaction.rollback).toHaveBeenCalled();
  });
});

describe('setDeclarationLines', () => {
  test('throws (and rolls back) when the declaration does not exist', async () => {
    queueResults({ recordset: [] }); // status check finds nothing
    await expect(db.setDeclarationLines(999, [])).rejects.toThrow('Declaration not found.');
    expect(transaction.rollback).toHaveBeenCalled();
  });

  test('throws (and rolls back) when the declaration is not a Draft', async () => {
    queueResults({ recordset: [{ Status: 'Confirmed' }] });
    await expect(db.setDeclarationLines(1, [])).rejects.toThrow('Only a Draft declaration can have its lines edited.');
    expect(transaction.rollback).toHaveBeenCalled();
  });

  test('replaces every line and updates TotalQty when the declaration is a Draft', async () => {
    queueResults(
      { recordset: [{ Status: 'Draft' }] }, // status check
      { recordset: [] }, // DELETE existing lines
      { recordset: [] }, // new line INSERT
      { recordset: [] }, // TotalQty UPDATE
    );
    await db.setDeclarationLines(1, [{ deliveryId: 1, material: 'M1', qtyAllocated: 12 }]);
    expect(dbRequest.query.mock.calls[1][0]).toContain('DELETE FROM log.ConsignmentDeclarationLine');
    expect(dbRequest.input).toHaveBeenCalledWith('totalQty', expect.anything(), 12);
    expect(transaction.commit).toHaveBeenCalled();
  });
});

describe('confirmDeclaration', () => {
  test('throws when the declaration does not exist', async () => {
    queueResults({ recordset: [] });
    await expect(db.confirmDeclaration(999, 'SET1', 100, 'j.smith')).rejects.toThrow('Declaration not found.');
  });

  test('throws naming the actual status when the declaration is not a Draft', async () => {
    queueResults({ recordset: [{ Status: 'Cancelled' }] });
    await expect(db.confirmDeclaration(1, 'SET1', 100, 'j.smith')).rejects.toThrow('Declaration is already Cancelled, not Draft.');
  });

  test('decrements RemainingQty on every delivery line, then marks Confirmed', async () => {
    queueResults(
      { recordset: [{ Status: 'Draft' }] },                                    // status check
      { recordset: [{ DeliveryId: 1, QtyAllocated: 10 }, { DeliveryId: 2, QtyAllocated: 5 }] }, // lines
      { rowsAffected: [1] },                                                    // decrement delivery 1
      { rowsAffected: [1] },                                                    // decrement delivery 2
      { recordset: [] },                                                        // mark Confirmed
      { recordset: [{ DeclarationId: 1, Status: 'Confirmed' }] },               // getDeclaration's header re-read
      { recordset: [] },                                                        // getDeclaration's lines re-read
    );
    const result = await db.confirmDeclaration(1, 'SET1', 100, 'j.smith');
    expect(transaction.commit).toHaveBeenCalled();
    expect(result.Status).toBe('Confirmed');
  });

  test('rolls back and throws a clear message when a delivery no longer has enough remaining balance', async () => {
    queueResults(
      { recordset: [{ Status: 'Draft' }] },
      { recordset: [{ DeliveryId: 1, QtyAllocated: 999 }] },
      { rowsAffected: [0] }, // the guarded UPDATE affected nothing — insufficient balance
    );
    await expect(db.confirmDeclaration(1, 'SET1', 100, 'j.smith')).rejects.toThrow(/no longer has enough remaining balance/);
    expect(transaction.rollback).toHaveBeenCalled();
  });
});

describe('cancelDeclaration', () => {
  test('cancels a Draft declaration', async () => {
    queueResults({ rowsAffected: [1] });
    await expect(db.cancelDeclaration(1)).resolves.toBeUndefined();
  });

  test('throws when the declaration is not a Draft (or does not exist)', async () => {
    queueResults({ rowsAffected: [0] });
    await expect(db.cancelDeclaration(1)).rejects.toThrow('Only a Draft declaration can be cancelled');
  });
});

describe('getConsignmentDeclarationStockSummary', () => {
  test('computes startingStock as DeliveredTotal minus Declared(Confirmed, excluding this declaration), one query per material', async () => {
    queueResults(
      { recordset: [{ DeliveredTotal: 500, DeliveredSinceLastDecl: 120, DeclaredConfirmedExcludingThis: 100 }] },
      { recordset: [{ DeliveredTotal: 200, DeliveredSinceLastDecl: 0, DeclaredConfirmedExcludingThis: 0 }] },
    );
    const result = await db.getConsignmentDeclarationStockSummary(5, 1, ['MAT-A', 'MAT-B']);
    expect(result).toEqual({
      'MAT-A': { startingStock: 400, deliveries: 120 },
      'MAT-B': { startingStock: 200, deliveries: 0 },
    });
    expect(dbRequest.query).toHaveBeenCalledTimes(2);
  });

  test('defaults to zero on an unexpected empty recordset', async () => {
    queueResults({ recordset: [] });
    const result = await db.getConsignmentDeclarationStockSummary(5, 1, ['MAT-A']);
    expect(result).toEqual({ 'MAT-A': { startingStock: 0, deliveries: 0 } });
  });
});

describe('getVendorDeliveredAndDeclaredTotals / listDeclarations', () => {
  test('getVendorDeliveredAndDeclaredTotals returns the per-material recordset', async () => {
    queueResults({ recordset: [{ Material: 'M1', Delivered: 100, Declared: 40 }] });
    const rows = await db.getVendorDeliveredAndDeclaredTotals(1);
    expect(rows).toEqual([{ Material: 'M1', Delivered: 100, Declared: 40 }]);
  });

  test('listDeclarations filters by vendorId when given', async () => {
    queueResults({ recordset: [{ DeclarationId: 1 }] });
    await db.listDeclarations(5);
    expect(dbRequest.query.mock.calls[0][0]).toContain('WHERE dec.VendorId = @vendorId');
  });

  test('listDeclarations returns everything when no vendorId is given', async () => {
    queueResults({ recordset: [] });
    await db.listDeclarations();
    expect(dbRequest.query.mock.calls[0][0]).not.toContain('WHERE');
  });
});
