// lib/unitConversion.js — the KG<->vendor-order-unit conversion used at the
// boundary points where an internal (always-KG) quantity crosses into the
// real world: the SAP PO itself, the PO PDF sent to the supplier, and goods-
// receipt quantities confirmed off the supplier's own delivery paperwork
// (all in routes/performance.js). See that module's header comment for why
// everything else in the app deliberately stays in KG.

import { describe, test, expect } from '@jest/globals';
import { convertQty } from '../../lib/unitConversion.js';

describe('convertQty', () => {
  test('same unit is a no-op regardless of casing', () => {
    expect(convertQty(1234.5, 'KG', 'KG')).toBe(1234.5);
    expect(convertQty(1234.5, 'kg', 'Kg')).toBe(1234.5);
  });

  test('defaults a missing/undefined unit to KG on both sides', () => {
    expect(convertQty(100, undefined, undefined)).toBe(100);
    expect(convertQty(100, null, 'KG')).toBe(100);
  });

  test('converts KG to LB using the standard avoirdupois pound factor', () => {
    // 1 LB = 0.45359237 KG, so 1 KG = 1/0.45359237 LB ≈ 2.20462262 LB.
    expect(convertQty(100, 'KG', 'LB')).toBeCloseTo(220.462262, 5);
  });

  test('converts LB to KG as the exact inverse of KG to LB', () => {
    const lb = convertQty(500, 'KG', 'LB');
    expect(convertQty(lb, 'LB', 'KG')).toBeCloseTo(500, 9);
  });

  test('throws on an unsupported unit rather than silently passing the value through', () => {
    expect(() => convertQty(100, 'KG', 'PC')).toThrow(/Unsupported unit conversion/);
    expect(() => convertQty(100, 'GAL', 'KG')).toThrow(/Unsupported unit conversion/);
  });
});
