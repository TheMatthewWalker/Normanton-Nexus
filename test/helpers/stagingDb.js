// Shared helper for integration tests that hit the real staging SQL Server
// (the new, migrated version) instead of a mocked mssql module. These are
// the tests that can actually catch version-migration behavior differences
// (collation, rounding, whether legacy nvarchar-as-date columns survived) —
// mocks can't.
//
// Gated on env vars so `npm test` stays runnable with no DB reachable (as on
// a fresh checkout, or this dev machine today): every *.integration.test.js
// file should import hasStagingDb() and wrap its whole describe block in
// `(hasStagingDb() ? describe : describe.skip)(...)` so it's reported as
// skipped, not failed, when unset.
//
// Required env vars: TEST_SQL_SERVER, TEST_SQL_DATABASE, TEST_SQL_USER,
// TEST_SQL_PASSWORD — point these at the staging instance once it exists.

import sql from 'mssql';

export function hasStagingDb() {
  return !!(process.env.TEST_SQL_SERVER && process.env.TEST_SQL_DATABASE);
}

export function stagingSqlConfig() {
  return {
    server:   process.env.TEST_SQL_SERVER,
    database: process.env.TEST_SQL_DATABASE,
    user:     process.env.TEST_SQL_USER,
    password: process.env.TEST_SQL_PASSWORD,
    options: {
      encrypt: process.env.TEST_SQL_ENCRYPT !== 'false',
      trustServerCertificate: true,
    },
  };
}

export async function connectStaging() {
  return sql.connect(stagingSqlConfig());
}
