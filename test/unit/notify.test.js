// lib/notify.js's real logic is fanOut()'s target-type switch — it builds a
// different inner SELECT depending on target.type (user/department/
// permission/role/all), all folded into a single INSERT...SELECT query
// against a mocked pool. Verified here by inspecting the actual query text
// the mocked pool receives, since fanOut doesn't return anything itself.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let notify;

beforeAll(async () => {
  ({ notify } = await import('../../lib/notify.js'));
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

test('throws when title or body is missing', async () => {
  await expect(notify(pool, { title: '', body: 'x' })).rejects.toThrow(/title and body are required/);
  await expect(notify(pool, { title: 'x', body: '' })).rejects.toThrow(/title and body are required/);
});

test('returns the new NotificationID', async () => {
  queueResults({ recordset: [{ NotificationID: 42 }] }, { recordset: [] });
  const id = await notify(pool, { title: 'Hi', body: 'Body' });
  expect(id).toBe(42);
});

describe('fanOut target-type routing', () => {
  test.each([
    ['user', 'WHERE Username = @val AND IsActive = 1'],
    ['department', 'ud.Department = @val'],
    ['permission', 'up.PermissionCode = @val'],
    ['role', 'WHERE Role = @val'],
  ])('target type "%s" queries the matching user set', async (type, expectedFragment) => {
    queueResults({ recordset: [{ NotificationID: 1 }] }, { recordset: [] });
    await notify(pool, { title: 'Hi', body: 'Body', target: { type, value: 'x' } });
    const fanoutSql = dbRequest.query.mock.calls[1][0];
    expect(fanoutSql).toContain(expectedFragment);
  });

  test('an unrecognised or "all" target type falls back to every active user', async () => {
    queueResults({ recordset: [{ NotificationID: 1 }] }, { recordset: [] });
    await notify(pool, { title: 'Hi', body: 'Body', target: { type: 'all' } });
    const fanoutSql = dbRequest.query.mock.calls[1][0];
    expect(fanoutSql).toContain('SELECT UserID FROM dbo.PortalUsers\n        WHERE IsActive = 1');
  });

  test('the fan-out insert guards against duplicate deliveries for the same notification+user', async () => {
    queueResults({ recordset: [{ NotificationID: 1 }] }, { recordset: [] });
    await notify(pool, { title: 'Hi', body: 'Body' });
    const fanoutSql = dbRequest.query.mock.calls[1][0];
    expect(fanoutSql).toContain('WHERE NOT EXISTS');
  });
});
