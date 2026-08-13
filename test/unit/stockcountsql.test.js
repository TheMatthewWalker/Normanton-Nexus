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
