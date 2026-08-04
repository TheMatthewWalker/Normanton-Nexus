// Targets performancesql.js directly (mssql mocked, not performancesql.js
// itself) — specifically createDemandAdjustment's overlap-rejection rule,
// called out in the file's own comments as the thing that keeps its 400s
// meaningful. Since mssql is mocked, these tests verify the JS-side handling
// of an overlap query result (throwing a 400 with a well-formatted message,
// including the null-EndDate "indefinitely" case) — not the real SQL WHERE
// clause's date-range predicate itself, which only a real-DB integration
// test could confirm. The rest of this 1984-line file's query logic isn't
// covered yet; performance.test.js covers the routing layer that calls into it.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let createDemandAdjustment;

beforeAll(async () => {
  ({ createDemandAdjustment } = await import('../../routes/performancesql.js'));
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

describe('createDemandAdjustment', () => {
  test('rejects with a 400 when an overlapping adjustment already exists for the material', async () => {
    dbRequest.query.mockResolvedValueOnce({
      recordset: [{ AdjustmentId: 5, StartDate: '2026-01-01T00:00:00Z', EndDate: '2026-03-01T00:00:00Z' }],
    });

    await expect(createDemandAdjustment({
      material: '30005R', startDate: '2026-02-01T00:00:00', endDate: '2026-02-15T00:00:00', usagePercent: 50,
    })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('2026-01-01 to 2026-03-01'),
    });

    // Never reaches the INSERT once an overlap is found.
    expect(dbRequest.query).toHaveBeenCalledTimes(1);
  });

  test('creates the adjustment when no overlap exists', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [] }) // no overlap
      .mockResolvedValueOnce({ recordset: [{ AdjustmentId: 9 }] }); // INSERT ... OUTPUT

    const id = await createDemandAdjustment({
      material: '30005R', startDate: '2026-02-01T00:00:00', endDate: '2026-02-15T00:00:00', usagePercent: 50,
    });

    expect(id).toBe(9);
  });

  test('formats an open-ended overlap (no EndDate) as "indefinitely" rather than crashing on the null date', async () => {
    dbRequest.query.mockResolvedValueOnce({
      recordset: [{ AdjustmentId: 3, StartDate: '2026-01-01T00:00:00Z', EndDate: null }],
    });

    await expect(createDemandAdjustment({
      material: '30005R', startDate: '2026-06-01T00:00:00', endDate: '2026-07-01T00:00:00', usagePercent: 25,
    })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('2026-01-01 to indefinitely'),
    });
  });
});
