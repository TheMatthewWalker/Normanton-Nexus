// routes/performanceallocation.js is pure logic (no router, no DB) —
// FIFO stock allocation for the Order Book report. allocateStock() sorts
// agreement lines by requestDate and greedily allocates each line against
// two independent pools (dock stock keyed by material+customer, staged/
// picked stock keyed by material+staging-bin), depleting each pool as
// earlier-dated lines consume it. packagingCustomer() and stagingBin() are
// its two small parsing/formatting helpers.

import { describe, test, expect } from '@jest/globals';
import { packagingCustomer, stagingBin, allocateStock } from '../../routes/performanceallocation.js';

describe('packagingCustomer', () => {
  test('extracts the customer code from an IB_<customer>_ packaging material', () => {
    expect(packagingCustomer('IB_363660_MB')).toBe('363660');
  });

  test('returns null when the material does not match the IB_ pattern', () => {
    expect(packagingCustomer('SOMETHING_ELSE')).toBeNull();
  });

  test('returns null for null/undefined/empty input', () => {
    expect(packagingCustomer(null)).toBeNull();
    expect(packagingCustomer(undefined)).toBeNull();
    expect(packagingCustomer('')).toBeNull();
  });
});

describe('stagingBin', () => {
  test('zero-pads a reference document to 10 characters', () => {
    expect(stagingBin('123')).toBe('0000000123');
  });

  test('leaves an already-10-character value unchanged', () => {
    expect(stagingBin('1234567890')).toBe('1234567890');
  });

  test('treats null/undefined as an empty string, padded', () => {
    expect(stagingBin(null)).toBe('0000000000');
    expect(stagingBin(undefined)).toBe('0000000000');
  });
});

describe('allocateStock', () => {
  test('allocates dock stock up to the available quantity, oldest requestDate first', () => {
    const agreementRows = [
      { material: 'M1', customer: 'C1', orderQty: 100, requestDate: '2026-01-10', referenceDocument: '1' },
      { material: 'M1', customer: 'C1', orderQty: 100, requestDate: '2026-01-05', referenceDocument: '2' },
    ];
    const stockRows = [{ material: 'M1', packagingMaterial: 'IB_C1_MB', availableQty: 150, storageBin: 'BIN1', totalQty: 0 }];

    const result = allocateStock(agreementRows, stockRows);

    // Sorted by requestDate: the Jan-5 line (ref 2) is allocated first.
    expect(result[0].referenceDocument).toBe('2');
    expect(result[0].dockStockAllocated).toBe(100);
    // Only 50 left in the pool for the later (Jan-10) line.
    expect(result[1].referenceDocument).toBe('1');
    expect(result[1].dockStockAllocated).toBe(50);
  });

  test('never allocates more than the line actually ordered, even with surplus stock', () => {
    const agreementRows = [{ material: 'M1', customer: 'C1', orderQty: 10, requestDate: '2026-01-01', referenceDocument: '1' }];
    const stockRows = [{ material: 'M1', packagingMaterial: 'IB_C1_MB', availableQty: 500, storageBin: 'BIN1', totalQty: 0 }];
    const result = allocateStock(agreementRows, stockRows);
    expect(result[0].dockStockAllocated).toBe(10);
  });

  test('allocates zero when no stock matches the line\'s material+customer key', () => {
    const agreementRows = [{ material: 'M1', customer: 'C1', orderQty: 10, requestDate: '2026-01-01', referenceDocument: '1' }];
    const stockRows = [{ material: 'M2', packagingMaterial: 'IB_C1_MB', availableQty: 500, storageBin: 'BIN1', totalQty: 0 }];
    const result = allocateStock(agreementRows, stockRows);
    expect(result[0].dockStockAllocated).toBe(0);
  });

  test('allocates staged/picked stock independently, keyed by material + zero-padded staging bin', () => {
    const agreementRows = [{ material: 'M1', customer: 'C1', orderQty: 20, requestDate: '2026-01-01', referenceDocument: '42' }];
    const stockRows = [{ material: 'M1', packagingMaterial: 'IB_C1_MB', availableQty: 0, storageBin: '0000000042', totalQty: 15 }];
    const result = allocateStock(agreementRows, stockRows);
    expect(result[0].pickedStockAllocated).toBe(15);
    expect(result[0].dockStockAllocated).toBe(0); // separate pool, no availableQty
  });

  test('depletes the staged pool across multiple lines sharing the same staging bin, oldest first', () => {
    const agreementRows = [
      { material: 'M1', customer: 'C1', orderQty: 10, requestDate: '2026-01-10', referenceDocument: '42' },
      { material: 'M1', customer: 'C1', orderQty: 10, requestDate: '2026-01-01', referenceDocument: '42' },
    ];
    const stockRows = [{ material: 'M1', packagingMaterial: 'IB_C1_MB', availableQty: 0, storageBin: '0000000042', totalQty: 12 }];
    const result = allocateStock(agreementRows, stockRows);
    expect(result[0].pickedStockAllocated).toBe(10); // earlier date, gets full 12 capped by its own orderQty of 10
    expect(result[1].pickedStockAllocated).toBe(2);  // later date, gets the remaining 2
  });

  test('sums multiple stock rows into the same pool key', () => {
    const agreementRows = [{ material: 'M1', customer: 'C1', orderQty: 30, requestDate: '2026-01-01', referenceDocument: '1' }];
    const stockRows = [
      { material: 'M1', packagingMaterial: 'IB_C1_MB', availableQty: 10, storageBin: 'BIN1', totalQty: 0 },
      { material: 'M1', packagingMaterial: 'IB_C1_MB', availableQty: 15, storageBin: 'BIN2', totalQty: 0 },
    ];
    const result = allocateStock(agreementRows, stockRows);
    expect(result[0].dockStockAllocated).toBe(25); // 10 + 15
  });

  test('accepts custom stockKey/agreementKey functions instead of the material+customer default', () => {
    const agreementRows = [{ material: 'M1', altKey: 'X', orderQty: 5, requestDate: '2026-01-01', referenceDocument: '1' }];
    const stockRows = [{ altKey: 'X', availableQty: 5, storageBin: 'BIN1', totalQty: 0 }];
    const result = allocateStock(agreementRows, stockRows, {
      stockKey: s => s.altKey,
      agreementKey: a => a.altKey,
    });
    expect(result[0].dockStockAllocated).toBe(5);
  });

  test('does not mutate the input array order — returns a new sorted array', () => {
    const agreementRows = [
      { material: 'M1', customer: 'C1', orderQty: 1, requestDate: '2026-01-10', referenceDocument: 'late' },
      { material: 'M1', customer: 'C1', orderQty: 1, requestDate: '2026-01-01', referenceDocument: 'early' },
    ];
    const originalOrder = agreementRows.map(r => r.referenceDocument);
    allocateStock(agreementRows, []);
    expect(agreementRows.map(r => r.referenceDocument)).toEqual(originalOrder);
  });
});
