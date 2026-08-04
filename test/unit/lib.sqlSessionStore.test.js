import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let SqlSessionStore;
let store;

beforeAll(async () => {
  ({ SqlSessionStore } = await import('../../lib/sqlSessionStore.js'));
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  store = new SqlSessionStore();
});

function callbackPromise(fn) {
  return new Promise((resolve) => {
    fn((err, result) => resolve({ err, result }));
  });
}

describe('get', () => {
  test('calls back with null when no matching (unexpired) session exists', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });
    const { err, result } = await callbackPromise(cb => store.get('sid-1', cb));
    expect(err).toBeNull();
    expect(result).toBeNull();
  });

  test('parses and returns the stored session JSON', async () => {
    const sessionData = { cookie: { expires: new Date().toISOString() }, user: { userID: 1 } };
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ SessionData: JSON.stringify(sessionData) }] });

    const { err, result } = await callbackPromise(cb => store.get('sid-1', cb));

    expect(err).toBeNull();
    expect(result).toEqual(sessionData);
  });

  test('calls back with an error if the query fails', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
    const { err } = await callbackPromise(cb => store.get('sid-1', cb));
    expect(err).toBeInstanceOf(Error);
  });
});

describe('set', () => {
  test('issues the upsert query and calls back with no error on success', async () => {
    dbRequest.query.mockResolvedValueOnce({});
    const { err } = await callbackPromise(cb => store.set('sid-1', { cookie: {} }, cb));
    expect(err).toBeNull();
    expect(dbRequest.query).toHaveBeenCalledTimes(1);
  });

  test('calls back with an error if the query fails', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('boom'));
    const { err } = await callbackPromise(cb => store.set('sid-1', { cookie: {} }, cb));
    expect(err).toBeInstanceOf(Error);
  });
});

describe('destroy', () => {
  test('issues the delete query and calls back with no error on success', async () => {
    dbRequest.query.mockResolvedValueOnce({});
    const { err } = await callbackPromise(cb => store.destroy('sid-1', cb));
    expect(err).toBeNull();
  });
});

describe('touch', () => {
  test('issues the update query and calls back with no error on success', async () => {
    dbRequest.query.mockResolvedValueOnce({});
    const { err } = await callbackPromise(cb => store.touch('sid-1', { cookie: {} }, cb));
    expect(err).toBeNull();
  });
});

describe('cleanupExpired', () => {
  test('returns the number of rows deleted', async () => {
    dbRequest.query.mockResolvedValueOnce({ rowsAffected: [7] });
    await expect(store.cleanupExpired()).resolves.toBe(7);
  });

  test('defaults to 0 when rowsAffected is missing', async () => {
    dbRequest.query.mockResolvedValueOnce({});
    await expect(store.cleanupExpired()).resolves.toBe(0);
  });
});
