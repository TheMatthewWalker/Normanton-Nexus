// routes/performanceforecast.js's computePredictedUsage() implements
// seasonal-index-weighted demand forecasting (see its own header comment
// for the full method writeup): baseLevel (trailing 12-month average) times
// a seasonalIndex derived from a 3/2/1-weighted average of the same
// calendar month across up to 3 prior years, clamped to avoid blowing up
// on low-volume materials. Pure function, no DB — fully unit-testable
// against hand-built consumption histories with known expected results.

import { describe, test, expect } from '@jest/globals';
import { computePredictedUsage } from '../../routes/performanceforecast.js';

function historyWith(overrides) {
  const h = new Array(36).fill(0);
  for (const [idx, val] of Object.entries(overrides)) h[idx] = val;
  return h;
}

describe('input handling', () => {
  test('a non-array input is treated as 36 months of zero consumption', () => {
    expect(computePredictedUsage(null)).toEqual(new Array(13).fill(0));
  });

  test('an array of the wrong length is treated as 36 months of zero consumption', () => {
    expect(computePredictedUsage([1, 2, 3])).toEqual(new Array(13).fill(0));
  });

  test('returns exactly 13 entries (current month through +12)', () => {
    expect(computePredictedUsage(new Array(36).fill(5))).toHaveLength(13);
  });

  test('an overallAverage of zero (no consumption at all) predicts zero throughout', () => {
    expect(computePredictedUsage(new Array(36).fill(0))).toEqual(new Array(13).fill(0));
  });
});

describe('flat, unseasonal consumption', () => {
  test('a perfectly flat history predicts the same flat level for every future month', () => {
    const result = computePredictedUsage(new Array(36).fill(100));
    expect(result.every(v => Math.abs(v - 100) < 1e-9)).toBe(true);
  });
});

describe('seasonal weighting', () => {
  // baseLevel = 10 (last 12 months, indices 24-35). Only two prior-year
  // same-calendar-month observations exist for k=0 (idx 23 and idx 11);
  // the 3-years-back one falls outside the 36-month window.
  const h = historyWith({ 23: 9, 11: 6, ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [24 + i, 10])) });

  test('weights a 2-year seasonal average 3:2 when the 3rd year falls outside the window', () => {
    const result = computePredictedUsage(h);
    // overallAverage = 135/36 = 3.75; weighted seasonal = (9*3+6*2)/5 = 7.8;
    // seasonalIndex = 7.8/3.75 = 2.08; predicted = 10 * 2.08 = 20.8
    expect(result[0]).toBeCloseTo(20.8, 6);
  });

  test('weights a full 3-year seasonal average 3:2:1 once all three years are in range', () => {
    const result = computePredictedUsage(h);
    // k=12 pulls offsets 0, -12, -24 -> h[35]=10, h[23]=9, h[11]=6, all present.
    // weighted = (10*3+9*2+6*1)/6 = 9; seasonalIndex = 9/3.75 = 2.4; predicted = 24
    expect(result[12]).toBeCloseTo(24, 6);
  });
});

describe('the seasonal-index safety clamp', () => {
  test('caps the seasonal index at 4x so a low-volume material can\'t spike absurdly', () => {
    // Last 12 months (baseLevel window) are all 1; one lone spike (1000) sits
    // 12 months back from "today", well outside the baseLevel window, so it
    // only affects the seasonal ratio, not the level.
    const h = historyWith({ 23: 1000, ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [24 + i, 1])) });
    const result = computePredictedUsage(h);
    // overallAverage = (1000 + 12*1)/36 = 28.11; seasonalRaw for k=0 = weighted
    // avg of just h[23]=1000 (only observation) = 1000; ratio = 1000/28.11 = 35.6,
    // clamped to 4. predicted[0] = baseLevel(1) * 4 = 4.
    expect(result[0]).toBeCloseTo(4, 6);
  });
});

describe('negative consumption values', () => {
  test('a negative baseLevel is floored to zero rather than predicting negative usage', () => {
    const h = historyWith({ ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [24 + i, -5])), 23: 10 });
    const result = computePredictedUsage(h);
    expect(result[0]).toBe(0);
  });
});

describe('coercion of non-numeric history entries', () => {
  test('non-numeric entries in an otherwise-valid 36-length array coerce to 0', () => {
    const h = new Array(36).fill(0).map((_, i) => (i === 35 ? 'not-a-number' : 10));
    const result = computePredictedUsage(h);
    // Just confirming it doesn't throw and produces finite numbers.
    expect(result.every(v => Number.isFinite(v))).toBe(true);
  });
});
