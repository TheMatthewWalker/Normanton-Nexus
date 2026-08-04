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
    expect(dbRequest.query.mock.calls[1][0]).toContain('INSERT INTO dbo.ConsignmentVendorConfig');
    expect(result).toEqual({ VendorId: 1, Active: 1 });
  });

  test('updates when a config row already exists', async () => {
    queueResults(
      { recordset: [{ 1: 1 }] },                     // exists check: found
      { recordset: [] },                              // the UPDATE
      { recordset: [{ VendorId: 1, Active: 0 }] },     // getConsignmentVendor's re-read
    );
    await db.upsertConsignmentVendorConfig(1, { active: false }, 'j.smith');
    expect(dbRequest.query.mock.calls[1][0]).toContain('UPDATE dbo.ConsignmentVendorConfig');
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
    queueResults({ rowsAffected: [1] }); // only one INSERT should run
    const result = await db.upsertConsignmentDeliveriesFromSap(1, [
      { material: 'M1', materialDocument: 'DOC1', materialDocItem: '0001', quantity: 10 },
      { material: 'M1', materialDocument: 'DOC1', materialDocItem: '0001', quantity: 10 }, // exact duplicate key
    ]);
    expect(dbRequest.query).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ inserted: 1 });
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
    expect(dbRequest.query.mock.calls[1][0]).toContain('DELETE FROM dbo.ConsignmentDeclarationLine');
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
