// routes/stockcountsql.js — DB layer for the Stock Count feature. Covers
// the fuzzy-match Levenshtein logic (pure, exercised through the exported
// function against a mocked snapshot result set), the variance/value
// computation in addCountLine, and getOrCreatePtfeCountForWeek's idempotent/
// race-collision paths. SAP calls, notification, and reporting queries are
// exercised via test/routes/stockcount.test.js instead — this file is pure
// SQL-shape and computation coverage.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let db;

beforeAll(async () => {
  db = await import('../../routes/stockcountsql.js');
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

describe('searchMaterialForCount', () => {
  test('returns the single matching row', async () => {
    dbRequest.query.mockResolvedValueOnce({
      recordset: [{ material: '30005R', materialText: '0.24mm 304 Wire', uom: 'M', unitPrice: 1.23 }],
    });
    const result = await db.searchMaterialForCount('30005R');
    expect(result).toEqual({ material: '30005R', materialText: '0.24mm 304 Wire', uom: 'M', unitPrice: 1.23 });
  });

  test('returns null when the material is not in the snapshot', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });
    const result = await db.searchMaterialForCount('BOGUS');
    expect(result).toBeNull();
  });
});

describe('fuzzyMatchMaterial', () => {
  test('ranks candidates by edit distance and excludes an exact match and anything beyond maxDistance', async () => {
    dbRequest.query.mockResolvedValueOnce({
      recordset: [
        { material: '30005R', materialText: 'exact match — should be excluded (distance 0)' },
        { material: '30005X', materialText: '1-char off' },
        { material: '30006R', materialText: '1-char off, different position' },
        { material: '30099R', materialText: '2-char off' },
        { material: 'ZZZZZZ', materialText: 'way off — should be excluded' },
      ],
    });

    const results = await db.fuzzyMatchMaterial('30005R', { maxDistance: 2, limit: 5 });

    expect(results.map(r => r.material)).toEqual(expect.arrayContaining(['30005X', '30006R', '30099R']));
    expect(results.map(r => r.material)).not.toContain('30005R');
    expect(results.map(r => r.material)).not.toContain('ZZZZZZ');
    // closer matches (distance 1) sort ahead of farther ones (distance 2)
    const distances = results.map(r => r.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  test('respects the limit', async () => {
    dbRequest.query.mockResolvedValueOnce({
      recordset: [
        { material: 'AAAAAX' }, { material: 'AAAAAY' }, { material: 'AAAAAZ' },
      ],
    });
    const results = await db.fuzzyMatchMaterial('AAAAA', { maxDistance: 2, limit: 2 });
    expect(results).toHaveLength(2);
  });
});


describe('addCountLine', () => {
  test('computes VarianceQty and VarianceValue from CountedQty/SapQty/UnitPrice', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ LineId: 5 }] });

    await db.addCountLine(1, {
      material: '30005R', materialText: 'Wire', uom: 'M', countedQty: 100, sapQty: 90, unitPrice: 2.5,
      isInvalidMaterial: false, isBatchManaged: false, enteredBy: 'j.smith',
    });

    expect(dbRequest.input).toHaveBeenCalledWith('varianceQty', expect.anything(), 10);
    expect(dbRequest.input).toHaveBeenCalledWith('varianceValue', expect.anything(), 25);
  });

  test('leaves VarianceQty/VarianceValue null when SAP has no comparable quantity yet', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ LineId: 6 }] });

    await db.addCountLine(1, {
      material: '30005R', countedQty: 100, sapQty: null, unitPrice: 2.5,
      isInvalidMaterial: false, isBatchManaged: false, enteredBy: 'j.smith',
    });

    expect(dbRequest.input).toHaveBeenCalledWith('varianceQty', expect.anything(), null);
    expect(dbRequest.input).toHaveBeenCalledWith('varianceValue', expect.anything(), null);
  });

  // Every physical lot counted on paper gets its own ticket + label — this
  // lives on the line, not the count document.
  test('persists a per-line ticketNumber', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ LineId: 7 }] });

    await db.addCountLine(1, {
      material: '30005R', countedQty: 100, sapQty: 90, unitPrice: 2.5, ticketNumber: 'TKT-1042',
      isInvalidMaterial: false, isBatchManaged: false, enteredBy: 'j.smith',
    });

    expect(dbRequest.input).toHaveBeenCalledWith('ticketNumber', expect.anything(), 'TKT-1042');
  });

  // The actual bug: variance must be computed from the *group's* running
  // total (cumulativeCountedQty), not this line's own CountedQty — two
  // lines of 12,000kg against a 12,000kg SAP figure must not both show as
  // "matched". CountedQty itself (the line's own physical entry) is
  // unaffected either way — only VarianceQty/VarianceValue should move.
  test('computes VarianceQty from cumulativeCountedQty (the group running total), not the line\'s own CountedQty', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ LineId: 102 }] });

    await db.addCountLine(2, {
      material: '10006', countedQty: 12000, cumulativeCountedQty: 24000, sapQty: 12000, unitPrice: 1,
      isInvalidMaterial: false, isBatchManaged: false, enteredBy: 'j.smith',
    });

    expect(dbRequest.input).toHaveBeenCalledWith('countedQty', expect.anything(), 12000); // this line's own entry, unchanged
    expect(dbRequest.input).toHaveBeenCalledWith('varianceQty', expect.anything(), 12000); // 24000 - 12000, not 12000 - 12000
    expect(dbRequest.input).toHaveBeenCalledWith('varianceValue', expect.anything(), 12000);
  });

  test('falls back to countedQty for the variance basis when cumulativeCountedQty is not given (first/only line in its group)', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ LineId: 101 }] });

    await db.addCountLine(2, {
      material: '10006', countedQty: 12000, sapQty: 12000, unitPrice: 1,
      isInvalidMaterial: false, isBatchManaged: false, enteredBy: 'j.smith',
    });

    expect(dbRequest.input).toHaveBeenCalledWith('varianceQty', expect.anything(), 0);
  });
});

describe('getGroupSiblingLines', () => {
  test('matches NULL StorageType/Bin (PRODUCTION, no WM concept) as equal to NULL, not excluded', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ LineId: 1, CountedQty: 50 }] });

    await db.getGroupSiblingLines(3, '40001', null, null);

    const sql = dbRequest.query.mock.calls[0][0];
    expect(sql).toContain('StorageType IS NULL AND @storageType IS NULL');
    expect(sql).toContain('Bin IS NULL AND @bin IS NULL');
    expect(sql).not.toContain('LineId <>'); // no excludeLineId given
  });

  test('excludes the given lineId when correcting an invalid line in place', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });
    await db.getGroupSiblingLines(3, '40001', 'PTF', 'B01', 5);
    expect(dbRequest.query.mock.calls[0][0]).toContain('LineId <> @excludeLineId');
    expect(dbRequest.input).toHaveBeenCalledWith('excludeLineId', expect.anything(), 5);
  });
});

describe('zeroLineVariances', () => {
  test('no-ops on an empty array without querying', async () => {
    await db.zeroLineVariances([]);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('zeroes VarianceQty/VarianceValue for every given line', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });
    await db.zeroLineVariances([101, 102]);
    const sql = dbRequest.query.mock.calls[0][0];
    expect(sql).toContain('VarianceQty = 0');
    expect(sql).toContain('VarianceValue = 0');
    expect(sql).toContain('LineId IN (@id0,@id1)');
  });
});

describe('recomputeGroupVariances', () => {
  // Reproduces the exact reported scenario: bin CONTAINER2, material 10006,
  // three lines of 12,000/12,000/6,000kg (30,000kg total) against a SAP
  // figure of 12,000kg — the group's real variance is +18,000kg, and only
  // the last-entered line should carry it; the earlier two should end up
  // at zero.
  test('replays a group in entry order, zeroing all but the last line, attributing the real cumulative variance there', async () => {
    dbRequest.query.mockResolvedValueOnce({
      recordset: [
        { LineId: 101, Material: '10006', StorageType: 'PTF', Bin: 'CONTAINER2', CountedQty: 12000, SapQty: 12000, UnitPrice: 1 },
        { LineId: 102, Material: '10006', StorageType: 'PTF', Bin: 'CONTAINER2', CountedQty: 12000, SapQty: 12000, UnitPrice: 1 },
        { LineId: 103, Material: '10006', StorageType: 'PTF', Bin: 'CONTAINER2', CountedQty: 6000,  SapQty: 12000, UnitPrice: 1 },
      ],
    });
    dbRequest.query.mockResolvedValue({ recordset: [] }); // the three subsequent UPDATEs

    const result = await db.recomputeGroupVariances(2);

    expect(result).toEqual({ groupCount: 1, lineCount: 3 });

    const updateCalls = dbRequest.input.mock.calls.filter(c => c[0] === 'varianceQty');
    expect(updateCalls.map(c => c[2])).toEqual([0, 0, 18000]);
    const valueCalls = dbRequest.input.mock.calls.filter(c => c[0] === 'varianceValue');
    expect(valueCalls.map(c => c[2])).toEqual([0, 0, 18000]);
  });

  test('skips a group with no SAP comparison at all (SapQty never set on any line)', async () => {
    dbRequest.query.mockResolvedValueOnce({
      recordset: [{ LineId: 1, Material: 'X', StorageType: null, Bin: null, CountedQty: 5, SapQty: null, UnitPrice: null }],
    });

    const result = await db.recomputeGroupVariances(2);

    expect(result).toEqual({ groupCount: 1, lineCount: 0 });
    expect(dbRequest.query).toHaveBeenCalledTimes(1); // only the initial SELECT, no UPDATEs
  });

  test('groups PRODUCTION lines (NULL StorageType/Bin) by material only, not conflating different materials', async () => {
    dbRequest.query.mockResolvedValueOnce({
      recordset: [
        { LineId: 1, Material: 'A', StorageType: null, Bin: null, CountedQty: 10, SapQty: 10, UnitPrice: 1 },
        { LineId: 2, Material: 'B', StorageType: null, Bin: null, CountedQty: 20, SapQty: 15, UnitPrice: 1 },
      ],
    });
    dbRequest.query.mockResolvedValue({ recordset: [] });

    const result = await db.recomputeGroupVariances(2);

    expect(result).toEqual({ groupCount: 2, lineCount: 2 });
    const varianceCalls = dbRequest.input.mock.calls.filter(c => c[0] === 'varianceQty').map(c => c[2]);
    expect(varianceCalls).toEqual(expect.arrayContaining([0, 5])); // A: 10-10=0, B: 20-15=5 (each is its group's only/last line)
  });
});

describe('getOrCreatePtfeCountForWeek', () => {
  const monday = new Date('2026-08-10');

  test('returns the existing count without inserting when one already exists for the week', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ CountId: 3, CountType: 'PTFE_WEEKLY' }] });

    const result = await db.getOrCreatePtfeCountForWeek(monday);

    expect(result).toEqual({ countId: 3, created: false });
    expect(dbRequest.query).toHaveBeenCalledTimes(1);
  });

  test('creates a new count when none exists for the week', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [] })              // getPtfeCountForWeek — none yet
      .mockResolvedValueOnce({ recordset: [{ CountId: 9 }] }); // createCountDocument INSERT

    const result = await db.getOrCreatePtfeCountForWeek(monday);

    expect(result).toEqual({ countId: 9, created: true });
  });

  test('falls back to the winner\'s row on a unique-index collision (race with the cron)', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [] })                                   // getPtfeCountForWeek — none yet
      .mockRejectedValueOnce(new Error('Violation of UNIQUE KEY constraint'))       // INSERT loses the race
      .mockResolvedValueOnce({ recordset: [{ CountId: 9, CountType: 'PTFE_WEEKLY' }] }); // re-fetch finds the winner

    const result = await db.getOrCreatePtfeCountForWeek(monday);

    expect(result).toEqual({ countId: 9, created: false });
  });
});
