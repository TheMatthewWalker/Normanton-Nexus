import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let configJS;

beforeAll(async () => {
  configJS = await import('../../config.js');
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

describe('idleTimeoutMsFor', () => {
  test('gives the 30-minute default for a normal user', () => {
    expect(configJS.idleTimeoutMsFor({ shortIdleTimeout: false })).toBe(configJS.IDLE_TIMEOUT_MS);
  });

  test('gives the 5-minute override for a flagged user', () => {
    expect(configJS.idleTimeoutMsFor({ shortIdleTimeout: true })).toBe(configJS.SHORT_IDLE_TIMEOUT_MS);
  });

  test('defaults to the 30-minute timeout when there is no session user at all', () => {
    expect(configJS.idleTimeoutMsFor(undefined)).toBe(configJS.IDLE_TIMEOUT_MS);
  });

  test('the short timeout is genuinely shorter than the default', () => {
    expect(configJS.SHORT_IDLE_TIMEOUT_MS).toBeLessThan(configJS.IDLE_TIMEOUT_MS);
  });
});

describe('DEPT_PAGE_MAP', () => {
  test('maps every department page to its department', () => {
    expect(configJS.DEPT_PAGE_MAP['production.html']).toBe('production');
    expect(configJS.DEPT_PAGE_MAP['production-nexus.html']).toBe('production');
    expect(configJS.DEPT_PAGE_MAP['finance.html']).toBe('finance');
  });

  test('does not map admin/landing pages (those are role-gated, not department-gated)', () => {
    expect(configJS.DEPT_PAGE_MAP['admin.html']).toBeUndefined();
    expect(configJS.DEPT_PAGE_MAP['landing.html']).toBeUndefined();
  });
});

describe('stampDbChange (fire-and-forget)', () => {
  test('does nothing (no DB call) when username or tableName is missing', async () => {
    await configJS.stampDbChange(null, 'SomeTable');
    await configJS.stampDbChange('someuser', null);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('never throws even when the query itself fails', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('boom'));
    await expect(configJS.stampDbChange('someuser', 'SomeTable')).resolves.toBeUndefined();
  });
});

describe('auditQuery (fire-and-forget)', () => {
  test('never throws even when the underlying query fails', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('boom'));
    await expect(configJS.auditQuery('SOME_EVENT', 'someuser', 'detail', { ip: '1.2.3.4' })).resolves.toBeUndefined();
  });

  test('resolves normally on a successful insert', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });
    await expect(configJS.auditQuery('SOME_EVENT', 'someuser', 'detail', { ip: '1.2.3.4' })).resolves.toBeUndefined();
    expect(dbRequest.query).toHaveBeenCalledTimes(1);
  });
});
