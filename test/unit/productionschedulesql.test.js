// routes/productionschedulesql.js is the DB layer for the Production
// Schedule / Arrears / OTIF reports. Two pieces of real logic live here and
// are worth testing directly against a mocked mssql pool rather than through
// the thin route wrapper: the working-day window/offset math driving
// getProductionSchedule's DisplayDate (verified against the file's own
// worked example — a Wednesday "today" puts the window start on Friday and
// end on the Thursday five working days later), and diffProductionScheduleOtif's
// insert/refresh/complete state machine (including the on-time-vs-late
// branch and its comment-reason lookup). System time is pinned via fake
// timers to a fixed Wednesday at noon UTC so "today" resolves the same
// local calendar date regardless of DST.

import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { jest } from '@jest/globals';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let db;

beforeAll(async () => {
  db = await import('../../routes/productionschedulesql.js');
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-01-07T12:00:00.000Z')); // a Wednesday
});

afterEach(() => {
  jest.useRealTimers();
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

function inputValues(name) {
  return dbRequest.input.mock.calls.filter(call => call[0] === name).map(call => call[2]);
}

describe('getProductionSchedule', () => {
  test('windows 5 working days starting 2 working days out from a Wednesday "today"', async () => {
    queueResults(
      { recordset: [] },
      { recordset: [] }, // listProductionScheduleComments isn't called by this function, but keep queue tidy
    );
    const { windowStart, windowEnd } = await db.getProductionSchedule();
    expect(windowStart.toISOString()).toBe('2026-01-09T00:00:00.000Z'); // Friday
    expect(windowEnd.toISOString()).toBe('2026-01-15T00:00:00.000Z');   // Thursday, 5 working days later
  });

  test('computes DisplayDate as RequestDate shifted back 2 working days', async () => {
    queueResults({
      recordset: [{ ReferenceDocument: 'SO1', Item: '10', RequestDate: new Date('2026-01-09T00:00:00.000Z') }],
    });
    const { rows } = await db.getProductionSchedule();
    expect(rows[0].DisplayDate.toISOString()).toBe('2026-01-07T00:00:00.000Z');
  });

  test('a null RequestDate maps to a null DisplayDate', async () => {
    queueResults({ recordset: [{ ReferenceDocument: 'SO1', Item: '10', RequestDate: null }] });
    const { rows } = await db.getProductionSchedule();
    expect(rows[0].DisplayDate).toBeNull();
  });
});

describe('getProductionArrears', () => {
  test('returns the raw recordset', async () => {
    queueResults({ recordset: [{ ReferenceDocument: 'SO2', Item: '20' }] });
    const rows = await db.getProductionArrears();
    expect(rows).toEqual([{ ReferenceDocument: 'SO2', Item: '20' }]);
  });
});

describe('listProductionScheduleComments', () => {
  test('keys the map by ReferenceDocument||Item', async () => {
    queueResults({
      recordset: [{ ReferenceDocument: 'SO1', Item: '10', Comment: 'Rush', Eta: null, LastUpdatedUtc: null, UpdatedByUsername: 'a.admin' }],
    });
    const map = await db.listProductionScheduleComments();
    expect(map.get('SO1||10')).toEqual({ comment: 'Rush', eta: null, lastUpdatedUtc: null, updatedByUsername: 'a.admin' });
  });
});

describe('upsertProductionScheduleComment', () => {
  test('binds referenceDocument/item/comment/eta/username as parameters', async () => {
    queueResults({ recordset: [] });
    await db.upsertProductionScheduleComment(
      { referenceDocument: 'SO1', item: '10', comment: 'Rush', eta: '2026-01-10' },
      'a.admin',
    );
    expect(inputValues('ref')).toEqual(['SO1']);
    expect(inputValues('item')).toEqual(['10']);
    expect(inputValues('comment')).toEqual(['Rush']);
    expect(inputValues('user')).toEqual(['a.admin']);
  });
});

describe('diffProductionScheduleOtif', () => {
  test('starts tracking a brand-new open line', async () => {
    queueResults(
      { recordset: [{ ReferenceDocument: 'SO1', Item: '10', Customer: 'C1', CustomerName: 'Acme', Material: 'M1', MaterialText: 'Widget', ValueStream: 'PTFE', OrderQty: 5, Uom: 'EA', RequestDate: new Date('2026-01-20') }] }, // openRows
      { recordset: [] }, // trackedOpen
      { recordset: [] }, // the INSERT
    );
    const result = await db.diffProductionScheduleOtif();
    expect(result).toEqual({ inserted: 1, refreshed: 0, completed: 0 });
    expect(dbRequest.query).toHaveBeenCalledTimes(3);
  });

  test('refreshes a line that is still open and already tracked', async () => {
    queueResults(
      { recordset: [{ ReferenceDocument: 'SO1', Item: '10', RequestDate: new Date('2026-01-20') }] }, // openRows
      { recordset: [{ TrackingID: 5, ReferenceDocument: 'SO1', Item: '10', DueDate: new Date('2026-01-18') }] }, // trackedOpen
      { recordset: [] }, // the UPDATE (refresh)
    );
    const result = await db.diffProductionScheduleOtif();
    expect(result).toEqual({ inserted: 0, refreshed: 1, completed: 0 });
    expect(inputValues('id')).toEqual([5]);
  });

  test('marks a disappeared line completed on-time without looking up a reason', async () => {
    queueResults(
      { recordset: [] }, // openRows — line is gone
      { recordset: [{ TrackingID: 9, ReferenceDocument: 'SO1', Item: '10', DueDate: new Date('2026-01-10T00:00:00.000Z') }] }, // trackedOpen — due date is after "today" (Jan 7)
      { recordset: [] }, // the completing UPDATE
    );
    const result = await db.diffProductionScheduleOtif();
    expect(result).toEqual({ inserted: 0, refreshed: 0, completed: 1 });
    expect(dbRequest.query).toHaveBeenCalledTimes(3); // no comment lookup
    expect(inputValues('onTime')).toEqual([true]);
    expect(inputValues('reason')).toEqual([null]);
  });

  test('marks a disappeared line completed late and captures its comment as the reason', async () => {
    queueResults(
      { recordset: [] }, // openRows — line is gone
      { recordset: [{ TrackingID: 9, ReferenceDocument: 'SO1', Item: '10', DueDate: new Date('2026-01-01T00:00:00.000Z') }] }, // trackedOpen — due date is before "today"
      { recordset: [{ Comment: 'Awaiting raw material' }] }, // the reason lookup
      { recordset: [] }, // the completing UPDATE
    );
    const result = await db.diffProductionScheduleOtif();
    expect(result).toEqual({ inserted: 0, refreshed: 0, completed: 1 });
    expect(dbRequest.query).toHaveBeenCalledTimes(4);
    expect(inputValues('onTime')).toEqual([false]);
    expect(inputValues('reason')).toEqual(['Awaiting raw material']);
  });
});

describe('getOtifKpiHistory / getOtifLateList', () => {
  test('getOtifKpiHistory returns the raw recordset', async () => {
    queueResults({ recordset: [{ Year: 2026, Month: 1, OnTimeCount: 8, TotalCount: 10 }] });
    const rows = await db.getOtifKpiHistory();
    expect(rows).toEqual([{ Year: 2026, Month: 1, OnTimeCount: 8, TotalCount: 10 }]);
  });

  test('getOtifLateList returns the raw recordset', async () => {
    queueResults({ recordset: [{ ReferenceDocument: 'SO1', Item: '10', Reason: 'Late' }] });
    const rows = await db.getOtifLateList();
    expect(rows).toEqual([{ ReferenceDocument: 'SO1', Item: '10', Reason: 'Late' }]);
  });
});
