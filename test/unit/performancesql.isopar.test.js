// Isopar Tied Oil (Material 10010) data-layer functions in routes/performancesql.js —
// meter readings, planning rate, received-deliveries, the shared computeIsoparPeriodFigures
// consumption calc, and declarations. mssql mocked via test/helpers/mockPool.js, same
// pattern as the rest of this file (see createDemandAdjustment above for the sibling
// reject-duplicate convention this mirrors).

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let db;

beforeAll(async () => {
  db = await import('../../routes/performancesql.js');
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

describe('createIsoparReading', () => {
  test('rejects with a 400 when a reading already exists for that date', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{}] }); // duplicate-check finds a row

    await expect(db.createIsoparReading({
      readingDate: '2026-08-12T00:00:00Z', readingQty: 1234.5, createdBy: 'tester',
    })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('2026-08-12'),
    });

    expect(dbRequest.query).toHaveBeenCalledTimes(1); // never reaches the INSERT
  });

  test('inserts when no reading exists yet for that date', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [] }) // no duplicate
      .mockResolvedValueOnce({ recordset: [{ ReadingId: 7 }] }); // INSERT ... OUTPUT

    const id = await db.createIsoparReading({ readingDate: '2026-08-12T00:00:00Z', readingQty: 1234.5, createdBy: 'tester' });

    expect(id).toBe(7);
  });
});

describe('updateIsoparReading / deleteIsoparReading', () => {
  test('update never touches ReadingDate — only ReadingQty/Notes are bindable inputs', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });
    await db.updateIsoparReading(7, { readingQty: 999, notes: 'corrected' });

    const inputNames = dbRequest.input.mock.calls.map(call => call[0]);
    expect(inputNames).toEqual(expect.arrayContaining(['readingId', 'readingQty', 'notes']));
    expect(inputNames).not.toContain('readingDate');
  });

  test('delete issues a single DELETE keyed on readingId', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });
    await db.deleteIsoparReading(7);
    expect(dbRequest.query).toHaveBeenCalledTimes(1);
  });
});

describe('getIsoparPlanningRate / updateIsoparPlanningRate', () => {
  test('getIsoparPlanningRate returns the single TOP-1-by-RateId row', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ RateId: 3, WeekdayRateLPerDay: 450, WeekendRateLPerDay: 50, Source: 'Manual' }] });
    const rate = await db.getIsoparPlanningRate();
    expect(rate).toMatchObject({ RateId: 3, WeekdayRateLPerDay: 450, WeekendRateLPerDay: 50 });
  });

  test('updateIsoparPlanningRate inserts a new version rather than updating in place', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ RateId: 4 }] });
    const id = await db.updateIsoparPlanningRate({ weekdayRateLPerDay: 480, weekendRateLPerDay: 60, source: 'Recommended', createdBy: 'tester' });
    expect(id).toBe(4);
    const query = dbRequest.query.mock.calls[0][0];
    expect(query).toMatch(/INSERT INTO log\.IsoparPlanningRate/);
  });
});

describe('computeIsoparPeriodFigures', () => {
  test('derives consumedQty = opening + received - closing, and complete:true when both readings exist', async () => {
    // Order: getIsoparReadingOnOrBefore(periodStart), getIsoparReadingOnOrBefore(periodEnd), listIsoparReceivedDeliveriesInRange
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ ReadingId: 1, ReadingDate: '2026-08-01T00:00:00Z', ReadingQty: 10000 }] }) // opening
      .mockResolvedValueOnce({ recordset: [{ ReadingId: 2, ReadingDate: '2026-10-31T00:00:00Z', ReadingQty: 4000 }] })  // closing
      .mockResolvedValueOnce({ recordset: [{ SuggestionId: 1, OrderQty: 5000, ReceivedQty: 5000, PoNumber: 'PO1' }] }); // deliveries

    const figures = await db.computeIsoparPeriodFigures(new Date('2026-08-01T00:00:00Z'), new Date('2026-10-31T00:00:00Z'));

    expect(figures.complete).toBe(true);
    expect(figures.openingStockQty).toBe(10000);
    expect(figures.closingStockQty).toBe(4000);
    expect(figures.receivedQty).toBe(5000);
    expect(figures.consumedQty).toBe(11000); // 10000 + 5000 - 4000
  });

  test('falls back to OrderQty for a delivery with no explicit ReceivedQty', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ ReadingId: 1, ReadingQty: 1000 }] })
      .mockResolvedValueOnce({ recordset: [{ ReadingId: 2, ReadingQty: 900 }] })
      .mockResolvedValueOnce({ recordset: [{ SuggestionId: 1, OrderQty: 500, ReceivedQty: null }] });

    const figures = await db.computeIsoparPeriodFigures(new Date('2026-08-01T00:00:00Z'), new Date('2026-08-07T00:00:00Z'));
    expect(figures.receivedQty).toBe(500);
    expect(figures.consumedQty).toBe(600); // 1000 + 500 - 900
  });

  test('complete:false and consumedQty:null when the opening reading is missing', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [] }) // no opening reading
      .mockResolvedValueOnce({ recordset: [{ ReadingId: 2, ReadingQty: 900 }] })
      .mockResolvedValueOnce({ recordset: [] });

    const figures = await db.computeIsoparPeriodFigures(new Date('2026-08-01T00:00:00Z'), new Date('2026-08-07T00:00:00Z'));
    expect(figures.complete).toBe(false);
    expect(figures.consumedQty).toBeNull();
  });
});

describe('createIsoparDeclaration', () => {
  test('rejects with a 400 when a declaration for that exact period already exists', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ DeclarationId: 1 }] }); // getIsoparDeclarationForPeriod finds one

    await expect(db.createIsoparDeclaration({
      periodStart: new Date('2026-08-01T00:00:00Z'), periodEnd: new Date('2026-10-31T00:00:00Z'),
      openingStockQty: 10000, receivedQty: 5000, closingStockQty: 4000, consumedQty: 11000,
      submittedByUserId: 1, submittedByUsername: 'tester',
    })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('already been submitted') });

    expect(dbRequest.query).toHaveBeenCalledTimes(1); // never reaches the INSERT
  });

  test('inserts when no declaration exists yet for the period', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [] }) // no existing declaration
      .mockResolvedValueOnce({ recordset: [{ DeclarationId: 9 }] }); // INSERT ... OUTPUT

    const id = await db.createIsoparDeclaration({
      periodStart: new Date('2026-08-01T00:00:00Z'), periodEnd: new Date('2026-10-31T00:00:00Z'),
      openingStockQty: 10000, receivedQty: 5000, closingStockQty: 4000, consumedQty: 11000,
      submittedByUserId: 1, submittedByUsername: 'tester',
    });
    expect(id).toBe(9);
  });
});

describe('listIsoparOutstandingPeriods', () => {
  test('returns [] when no period has ended yet', async () => {
    const result = await db.listIsoparOutstandingPeriods(new Date('2026-08-15T00:00:00Z'));
    expect(result).toEqual([]);
    expect(dbRequest.query).not.toHaveBeenCalled(); // isoparPeriodsEndedBefore is pure — short-circuits before any DB call
  });

  test('excludes a period that already has a matching declaration row', async () => {
    dbRequest.query.mockResolvedValueOnce({
      recordset: [{ PeriodStart: '2026-08-01T00:00:00.000Z', PeriodEnd: '2026-10-31T00:00:00.000Z' }],
    });
    const result = await db.listIsoparOutstandingPeriods(new Date('2026-11-01T00:00:00Z'));
    expect(result).toEqual([]);
  });

  test('includes a fully-ended period with no declaration row yet', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] }); // listIsoparDeclarations — nothing submitted
    const result = await db.listIsoparOutstandingPeriods(new Date('2026-11-01T00:00:00Z'));
    expect(result).toHaveLength(1);
    expect(result[0].index).toBe(0);
  });
});
