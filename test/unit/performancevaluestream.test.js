// routes/performancevaluestream.js is pure logic (no router, no DB): the
// profit-centre -> value-stream lookup table, its bare-vs-zero-padded PRCTR
// normalization, and computeTodayStockAndPickedTotals' per-row unit-price
// and stock/picked value aggregation grouped by value stream.

import { describe, test, expect } from '@jest/globals';
import {
  mapProfitCentreToValueStream,
  enrichWithValueStream,
  computeTodayStockAndPickedTotals,
} from '../../routes/performancevaluestream.js';

describe('mapProfitCentreToValueStream', () => {
  test('maps a bare profit centre code', () => {
    expect(mapProfitCentreToValueStream('2008')).toBe('PV');
  });

  test('maps a zero-padded (SAP PRCTR, 10-char) profit centre the same way', () => {
    expect(mapProfitCentreToValueStream('0000002008')).toBe('PV');
  });

  test('returns null for an unmapped profit centre', () => {
    expect(mapProfitCentreToValueStream('9999')).toBeNull();
  });

  test('returns null for null/undefined/empty input', () => {
    expect(mapProfitCentreToValueStream(null)).toBeNull();
    expect(mapProfitCentreToValueStream(undefined)).toBeNull();
    expect(mapProfitCentreToValueStream('')).toBeNull();
  });

  test('trims whitespace before mapping', () => {
    expect(mapProfitCentreToValueStream('  2000  ')).toBe('PTFE');
  });
});

describe('enrichWithValueStream', () => {
  test('stamps valueStream onto each row in place and returns the same array', () => {
    const rows = [{ profitCentre: '2000' }, { profitCentre: '2008' }, { profitCentre: '9999' }];
    const result = enrichWithValueStream(rows);
    expect(result).toBe(rows); // same array reference
    expect(rows.map(r => r.valueStream)).toEqual(['PTFE', 'PV', null]);
  });
});

describe('computeTodayStockAndPickedTotals', () => {
  test('computes stock/picked value from unit price (localAmount / orderQty)', () => {
    const rows = [{ valueStream: 'PTFE', orderQty: 10, localAmount: 100, dockStockAllocated: 4, pickedStockAllocated: 2 }];
    const totals = computeTodayStockAndPickedTotals(rows);
    // unitPrice = 100/10 = 10; stockValue = 4*10 = 40; pickedValue = 2*10 = 20
    expect(totals.get('PTFE')).toEqual({ stockValue: 40, pickedValue: 20 });
  });

  test('groups totals by valueStream across multiple rows', () => {
    const rows = [
      { valueStream: 'PTFE', orderQty: 10, localAmount: 100, dockStockAllocated: 1, pickedStockAllocated: 0 },
      { valueStream: 'PTFE', orderQty: 10, localAmount: 100, dockStockAllocated: 2, pickedStockAllocated: 0 },
      { valueStream: 'PV', orderQty: 5, localAmount: 50, dockStockAllocated: 1, pickedStockAllocated: 0 },
    ];
    const totals = computeTodayStockAndPickedTotals(rows);
    expect(totals.get('PTFE').stockValue).toBe(30); // (1+2)*10
    expect(totals.get('PV').stockValue).toBe(10);   // 1*10
  });

  test('falls back to "UNKNOWN" for rows with no valueStream', () => {
    const rows = [{ valueStream: null, orderQty: 10, localAmount: 100, dockStockAllocated: 1, pickedStockAllocated: 0 }];
    const totals = computeTodayStockAndPickedTotals(rows);
    expect(totals.has('UNKNOWN')).toBe(true);
    expect(totals.get('UNKNOWN').stockValue).toBe(10);
  });

  test('an orderQty of zero avoids a divide-by-zero and contributes nothing', () => {
    const rows = [{ valueStream: 'PTFE', orderQty: 0, localAmount: 100, dockStockAllocated: 5, pickedStockAllocated: 5 }];
    const totals = computeTodayStockAndPickedTotals(rows);
    expect(totals.has('PTFE')).toBe(false); // amount is 0 for both fields, add() skips zero amounts entirely
  });

  test('does not create a map entry at all when every amount is zero/falsy', () => {
    const rows = [{ valueStream: 'PTFE', orderQty: 10, localAmount: 0, dockStockAllocated: 0, pickedStockAllocated: 0 }];
    const totals = computeTodayStockAndPickedTotals(rows);
    expect(totals.size).toBe(0);
  });
});
