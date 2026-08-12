// routes/performance.js's checkIsoparDeclarationDue — the daily cron handler that warns
// ISOPAR_DECL holders when an Isopar Tied Oil period has ended and needs submitting.
// routes/performancesql.js (db) and lib/notify.js are both mocked wholesale; mssql is mocked
// for the "already notified?" dbo.Notifications lookup that runs before notify() is called.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const db = { listIsoparOutstandingPeriods: jest.fn() };
jest.unstable_mockModule('../../routes/performancesql.js', () => db);

const notify = jest.fn();
jest.unstable_mockModule('../../lib/notify.js', () => ({ notify }));

let checkIsoparDeclarationDue;

beforeAll(async () => {
  ({ checkIsoparDeclarationDue } = await import('../../routes/performance.js'));
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  db.listIsoparOutstandingPeriods.mockReset();
  notify.mockReset();
});

test('no outstanding period ⇒ no notify() call', async () => {
  db.listIsoparOutstandingPeriods.mockResolvedValueOnce([]);
  const result = await checkIsoparDeclarationDue();
  expect(result).toEqual({ notified: false });
  expect(notify).not.toHaveBeenCalled();
});

test('outstanding period with no prior matching notification title ⇒ notify() called once', async () => {
  db.listIsoparOutstandingPeriods.mockResolvedValueOnce([
    { index: 0, start: new Date('2026-08-01T00:00:00Z'), end: new Date('2026-10-31T00:00:00Z') },
  ]);
  dbRequest.query.mockResolvedValueOnce({ recordset: [] }); // no existing notification with this title

  const result = await checkIsoparDeclarationDue();

  expect(result).toEqual({ notified: true, periodEnd: '2026-10-31' });
  expect(notify).toHaveBeenCalledTimes(1);
  const call = notify.mock.calls[0][1];
  expect(call.title).toContain('2026-10-31');
  expect(call.target).toEqual({ type: 'permission', value: 'ISOPAR_DECL' });
});

test('outstanding period with a prior matching notification title ⇒ notify() not called again (idempotent)', async () => {
  db.listIsoparOutstandingPeriods.mockResolvedValueOnce([
    { index: 0, start: new Date('2026-08-01T00:00:00Z'), end: new Date('2026-10-31T00:00:00Z') },
  ]);
  dbRequest.query.mockResolvedValueOnce({ recordset: [{ NotificationID: 5 }] }); // already sent

  const result = await checkIsoparDeclarationDue();

  expect(result).toEqual({ notified: false, alreadySent: true });
  expect(notify).not.toHaveBeenCalled();
});

test('only the oldest outstanding period is notified when several have piled up', async () => {
  db.listIsoparOutstandingPeriods.mockResolvedValueOnce([
    { index: 0, start: new Date('2026-08-01T00:00:00Z'), end: new Date('2026-10-31T00:00:00Z') },
    { index: 1, start: new Date('2026-11-01T00:00:00Z'), end: new Date('2027-01-31T00:00:00Z') },
  ]);
  dbRequest.query.mockResolvedValueOnce({ recordset: [] });

  const result = await checkIsoparDeclarationDue();

  expect(result.periodEnd).toBe('2026-10-31'); // the oldest, not 2027-01-31
  expect(notify).toHaveBeenCalledTimes(1);
});
