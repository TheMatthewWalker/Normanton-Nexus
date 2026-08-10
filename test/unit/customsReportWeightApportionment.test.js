// routes/customsreport.js's apportionWeights() replicates the AT_Customs.xlsm
// workbook's exact weight-apportionment formula:
//   ROUND(SUMIFS(Shipments!TotalWeight, Shipments!PicksheetNumber, thisDelivery)
//         / SUMIFS(CUSTOMS!Quantity, CUSTOMS!DeliveryNumber, thisDelivery)
//         * thisLineQuantity, 2)
// Pure math, worth testing directly against hand-computed fixtures rather
// than through the full upload/SAP-enrichment route. digits()/parseSapDate()
// are the small ID-normalization/date-parsing helpers the row-assembly logic
// leans on to match IDs across differently-padded SAP table outputs.
// parseSapNumber() locks in a real production bug: RFC_READ_TABLE returns
// numeric fields (KCMENG, RFWRT, KBETR, KPEIN, ...) in the calling session's
// display format — European-style grouping, e.g. "2.748,000" — not a plain
// machine-parseable number. Number("2.748,000") is NaN; every call site that
// used to do `Number(x) || 0` silently zeroed out quantity/value, which in
// turn zeroed weight apportionment's totalQty and blanked every line's
// weight too. Confirmed against a real SapServer response the user pasted:
// {"quantity": "2.748,000"} for a live LIPS query.

import { describe, test, expect, jest } from '@jest/globals';
import { createMockSql } from '../helpers/mockPool.js';

// routes/customsreport.js imports routes/customsreportadmin.js, which
// imports mssql — mock it even though this test never touches the DB,
// same convention as the other pure-logic unit tests in this suite.
const { sqlModule } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let apportionWeights;
let digits;
let parseSapDate;
let parseSapNumber;

beforeAll(async () => {
  ({ apportionWeights, digits, parseSapDate, parseSapNumber } = await import('../../routes/customsreport.js'));
});

describe('apportionWeights', () => {
  test('a single delivery with a single line gets the full weight', () => {
    const lines = [{ deliveryKey: '80001234', quantity: 100, weight: null }];
    apportionWeights(lines, new Map([['80001234', 45]]));
    expect(lines[0].weight).toBe(45);
  });

  test('splits weight across multiple lines of the same delivery by quantity share', () => {
    const lines = [
      { deliveryKey: '82888744', quantity: 113, weight: null },
      { deliveryKey: '82888744', quantity: 217, weight: null },
    ];
    apportionWeights(lines, new Map([['82888744', 127]]));

    // total weight 127, total qty 330 -> unit rate 0.384848...
    expect(lines[0].weight).toBe(43.49); // ROUND(127/330*113, 2)
    expect(lines[1].weight).toBe(83.51); // ROUND(127/330*217, 2)
  });

  test('leaves weight null (not NaN/Infinity) when total quantity is zero', () => {
    const lines = [{ deliveryKey: '80009999', quantity: 0, weight: null }];
    apportionWeights(lines, new Map([['80009999', 50]]));
    expect(lines[0].weight).toBeNull();
  });

  test('treats a delivery missing from the weight map as zero weight, not a crash', () => {
    const lines = [{ deliveryKey: '80009999', quantity: 10, weight: null }];
    apportionWeights(lines, new Map());
    expect(lines[0].weight).toBe(0);
  });

  test('sums duplicate PicksheetNumber rows for the same delivery (SUMIFS semantics)', () => {
    // Caller is expected to have already summed duplicates into the map —
    // this test documents that apportionWeights itself just trusts the
    // total it's given, matching how routes/customsreport.js builds it.
    const weightByDelivery = new Map();
    const contributions = [30, 15]; // two uploaded rows for the same delivery
    for (const w of contributions) {
      weightByDelivery.set('80001234', (weightByDelivery.get('80001234') || 0) + w);
    }
    expect(weightByDelivery.get('80001234')).toBe(45);

    const lines = [{ deliveryKey: '80001234', quantity: 100, weight: null }];
    apportionWeights(lines, weightByDelivery);
    expect(lines[0].weight).toBe(45);
  });

  test('rounds to 2 decimal places like Excel ROUND', () => {
    const lines = [
      { deliveryKey: 'D1', quantity: 1, weight: null },
      { deliveryKey: 'D1', quantity: 2, weight: null },
      { deliveryKey: 'D1', quantity: 3, weight: null },
    ];
    apportionWeights(lines, new Map([['D1', 10]])); // total qty 6, unit rate 1.6666...
    expect(lines[0].weight).toBe(1.67);
    expect(lines[1].weight).toBe(3.33);
    expect(lines[2].weight).toBe(5);
  });

  test('keeps deliveries independent of each other', () => {
    const lines = [
      { deliveryKey: 'A', quantity: 10, weight: null },
      { deliveryKey: 'B', quantity: 10, weight: null },
    ];
    apportionWeights(lines, new Map([['A', 100], ['B', 5]]));
    expect(lines[0].weight).toBe(100);
    expect(lines[1].weight).toBe(5);
  });
});

describe('digits', () => {
  test('strips leading zeros from a purely-numeric SAP ID', () => {
    expect(digits('0082892007')).toBe('82892007');
    expect(digits('000010')).toBe('10');
    expect(digits('0000363533')).toBe('363533');
  });

  test('leaves an already-unpadded numeric string unchanged', () => {
    expect(digits('82892007')).toBe('82892007');
  });

  test('leaves a non-numeric value unchanged (material numbers, country codes)', () => {
    expect(digits('CP1166')).toBe('CP1166');
    expect(digits('GB')).toBe('GB');
  });

  test('handles null/undefined/empty safely', () => {
    expect(digits(null)).toBe('');
    expect(digits(undefined)).toBe('');
    expect(digits('')).toBe('');
  });
});

describe('parseSapDate', () => {
  test('parses the DD.MM.YYYY format RFC_READ_TABLE actually returns for character-mode date fields', () => {
    const d = parseSapDate('15.05.2026');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4); // 0-indexed
    expect(d.getDate()).toBe(15);
  });

  test('also parses a valid YYYYMMDD string (fallback format)', () => {
    const d = parseSapDate('20260515');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4); // 0-indexed
    expect(d.getDate()).toBe(15);
  });

  test('returns null for a blank/zero date (SAP\'s "no date" convention)', () => {
    expect(parseSapDate('00000000')).toBeNull();
    expect(parseSapDate('00.00.0000')).toBeNull();
    expect(parseSapDate('')).toBeNull();
    expect(parseSapDate(null)).toBeNull();
  });

  test('returns null for a malformed string', () => {
    expect(parseSapDate('not-a-date')).toBeNull();
    expect(parseSapDate('2026-05-15')).toBeNull();
  });
});

describe('parseSapNumber', () => {
  test('parses a European-grouped SAP quantity (real LIPS response format)', () => {
    expect(parseSapNumber('2.748,000')).toBe(2748);
    expect(parseSapNumber('1.915,000')).toBe(1915);
  });

  test('parses a plain integer string with no separators', () => {
    expect(parseSapNumber('594')).toBe(594);
  });

  test('parses a European-grouped value with a fractional remainder', () => {
    expect(parseSapNumber('1.234,56')).toBe(1234.56);
  });

  test('returns 0 for blank/null/undefined rather than NaN', () => {
    expect(parseSapNumber('')).toBe(0);
    expect(parseSapNumber(null)).toBe(0);
    expect(parseSapNumber(undefined)).toBe(0);
  });

  test('returns 0 for a genuinely non-numeric value rather than NaN propagating into a report cell', () => {
    expect(parseSapNumber('n/a')).toBe(0);
  });
});
