// Builds a fake `mssql` module for jest.unstable_mockModule('mssql', ...).
//
// One shared `request` object backs every pool.request() call. That matches
// how routes actually use it: even routes/auth.js's Promise.all([...]) case
// (parallel department/permission lookups) evaluates both
// `pool.request().input(...).query(...)` expressions synchronously,
// left-to-right, before either awaits — so queuing results on request.query
// via mockResolvedValueOnce(), in call order, lines up correctly.
//
// Usage in a test file:
//   import { jest } from '@jest/globals';
//   const { sqlModule, request } = createMockSql();
//   jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));
//   const { default: someRoute } = await import('../../routes/whatever.js');
//   request.query.mockResolvedValueOnce({ recordset: [{ ... }] });

import { jest } from '@jest/globals';

export function createMockSql() {
  const request = {
    input: jest.fn(),
    query: jest.fn(),
  };
  request.input.mockReturnValue(request);

  const pool = { request: jest.fn(() => request) };
  const connect = jest.fn().mockResolvedValue(pool);

  // `new sql.Transaction(pool)` (used by any route batching several writes
  // atomically — see routes/consignmentsql.js/shipmentmain.js). begin/
  // commit/rollback are single shared jest.fn()s (reset, not re-created,
  // between tests) so `expect(transaction.commit).toHaveBeenCalled()` works
  // regardless of how many `new sql.Transaction(pool)` calls a test exercises.
  // tx.request() intentionally returns the SAME shared `request` object as
  // pool.request() — real mssql gives a transaction its own Request bound to
  // the connection, but nothing in this codebase distinguishes the two, and
  // sharing one query history keeps call-order assertions simple regardless
  // of whether a given query ran inside or outside the transaction.
  const transaction = {
    begin:    jest.fn().mockResolvedValue(undefined),
    commit:   jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    request:  jest.fn(() => request),
  };
  const Transaction = jest.fn(() => transaction);
  // config.js's getProductionPool()/getLogisticsPool() go through
  // `new sql.ConnectionPool(...)` then `.connect()`, not `sql.connect(...)` —
  // a different entry point than most routes use, but it must land on this
  // same shared `pool` (with `.request()`), not a disconnected stub, or any
  // route using those two helpers gets "pool.request is not a function".
  pool.connect = jest.fn().mockResolvedValue(undefined);
  // config.js's getIsolatedNexusConnection() (the admin SQL console's
  // per-query throwaway connection) always calls pool.close() when done.
  pool.close = jest.fn().mockResolvedValue(undefined);

  const knownTypes = {
    // Type "constructors" — mssql exposes these as classes; nothing in this
    // codebase inspects their return value, only that calling/referencing
    // them doesn't throw, so plain stand-ins are enough.
    NVarChar: jest.fn(n => `NVarChar(${n})`),
    VarChar:  jest.fn(n => `VarChar(${n})`),
    Decimal:  jest.fn((p, s) => `Decimal(${p},${s})`),
    Int:      'Int',
    Bit:      'Bit',
    BigInt:   'BigInt',
    DateTime: 'DateTime',
  };

  const base = {
    connect,
    ConnectionPool: jest.fn(() => pool),
    Transaction,
    ...knownTypes,
  };

  // mssql exposes dozens of SQL type tags (BigInt, Decimal(p,s), TinyInt,
  // DateTime2, MAX, ...) — some referenced as bare values, some called as
  // functions with precision/scale args (sql.Decimal(18, 2)). Rather than
  // enumerate every one by hand (and hit a fresh "sql.X is not a function"
  // every time a new route file uses one this suite hasn't yet), a Proxy
  // lazily fills in any unlisted property with something that's safely
  // both: a callable jest.fn() (so sql.Decimal(18, 2) doesn't throw) that's
  // also a valid bare value on its own (so sql.BigInt used unparenthesized
  // works too). Real values above always take precedence.
  //
  // Caveat: the Proxy creates a NEW jest.fn() on every access of an
  // unlisted property, so it does NOT preserve reference equality the way
  // real mssql's actual type tags do (`sql.BigInt === sql.BigInt` is true
  // for the real driver, false through this fallback). If a route ever
  // compares a stored type tag by reference (e.g.
  // `sqlType === sql.BigInt`), add that type to knownTypes above with a
  // stable value — routes/filterrecords.js's exact-match BigInt branch is
  // the first one that needed this.
  const sqlModule = new Proxy(base, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string') return undefined;
      return jest.fn();
    },
  });

  return { sqlModule, pool, request, connect, transaction, Transaction };
}

// Resets call history/queued results between tests without re-mocking the
// module (jest.unstable_mockModule + dynamic import must only happen once
// per test file — see individual test files' beforeAll).
export function resetMockSql({ pool, request, connect, transaction, Transaction }) {
  request.input.mockClear();
  request.query.mockReset();
  pool.request.mockClear();
  pool.connect?.mockClear();
  pool.close?.mockClear();
  connect.mockClear();
  if (transaction) {
    transaction.begin.mockClear();
    transaction.commit.mockClear();
    transaction.rollback.mockClear();
    transaction.request.mockClear();
  }
  Transaction?.mockClear();
}
