// Verifies that the CONVERT(datetime, @val, N) style codes this codebase
// actually relies on for parsing legacy nvarchar-stored dates (routes/mixing.js,
// routes/productionnexus.js, routes/consignment.js, routes/deploy.js) still
// behave identically on the new (migrated) SQL Server. This is exactly the
// class of risk a mocked mssql module can never catch — it only shows up by
// running the real query against the real server. Style codes covered here
// are every one actually grepped out of routes/*.js — see the CONVERT(...)
// call sites for where each is used.
//
// Skips (not fails) unless TEST_SQL_SERVER/TEST_SQL_DATABASE are set.

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { hasStagingDb, connectStaging } from '../helpers/stagingDb.js';

(hasStagingDb() ? describe : describe.skip)('legacy date CONVERT() styles — staging DB integration', () => {
  let pool;

  beforeAll(async () => { pool = await connectStaging(); }, 30000);
  afterAll(async () => { if (pool) await pool.close(); });

  async function convert(value, style) {
    const result = await pool.request()
      .input('v', value)
      .query(`SELECT CONVERT(datetime, @v, ${style}) AS parsed`);
    return result.recordset[0].parsed;
  }

  test('style 4 — dd.mm.yy (2-digit year), used for the legacy nvarchar-as-date columns', async () => {
    const parsed = await convert('15.03.26 14:30:00', 4);
    expect(parsed.toISOString().slice(0, 19)).toBe('2026-03-15T14:30:00');
  });

  test('style 104 — dd.mm.yyyy, used by routes/mixing.js date-range filters', async () => {
    const parsed = await convert('15.03.2026', 104);
    expect(parsed.toISOString().slice(0, 10)).toBe('2026-03-15');
  });

  test('style 120 — yyyy-mm-dd hh:mi:ss (ODBC canonical), used by routes/productionnexus.js and routes/deploy.js', async () => {
    const parsed = await convert('2026-03-15 14:30:00', 120);
    expect(parsed.toISOString().slice(0, 19)).toBe('2026-03-15T14:30:00');
  });

  test('style 126 — ISO8601, used for SAP-sourced timestamps', async () => {
    const parsed = await convert('2026-03-15T14:30:00', 126);
    expect(parsed.toISOString().slice(0, 19)).toBe('2026-03-15T14:30:00');
  });

  test('round-trip: CONVERT(varchar, ..., 126) then back to datetime matches the original', async () => {
    const result = await pool.request().query(`
      DECLARE @d datetime = '2026-03-15T09:05:00';
      SELECT CONVERT(varchar(30), @d, 126) AS asText,
             CONVERT(datetime, CONVERT(varchar(30), @d, 126), 126) AS roundTripped
    `);
    const row = result.recordset[0];
    expect(row.roundTripped.toISOString().slice(0, 19)).toBe('2026-03-15T09:05:00');
  });
});
