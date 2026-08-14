'use strict';
// Follow-up to 20260814120000_stock_count.cjs — that file was edited in
// place twice after it had already been applied against the real database
// (once to drop log.StockCountLocationMap in favour of free-typed PTFE
// bins validated against SAP LAGP, once to move TicketNumber from
// log.StockCountDocument to log.StockCountLine — every physical lot on
// paper gets its own ticket + label, not once per whole count). Editing an
// already-applied knex migration file doesn't retroactively change a
// database it already ran against (knex tracks completed migrations by
// filename in its own knex_migrations table, not by content), so the
// deployed schema was left on the original shape while the source file
// moved on — surfaced as "Invalid column name 'TicketNumber'" the first
// time routes/stockcountsql.js queried log.StockCountLine for a column
// that only exists in the file's current (edited) version, not in what was
// actually deployed. This migration brings a database that ran the
// original version up to the current shape; every check is independently
// guarded so it's also a no-op against a database that (for whatever
// reason) already matches.

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'log.StockCountLine') AND name = 'TicketNumber')
ALTER TABLE log.StockCountLine ADD TicketNumber NVARCHAR(30) NULL`);

  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'log.StockCountDocument') AND name = 'TicketNumber')
ALTER TABLE log.StockCountDocument DROP COLUMN TicketNumber`);

  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.StockCountLocationMap') AND type = 'U')
DROP TABLE log.StockCountLocationMap`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
  // Not meaningfully reversible — log.StockCountLocationMap's original
  // data (if any existed before this ran) is gone, and there's no single
  // correct count-level TicketNumber to reconstruct from what's now spread
  // across a count's lines. Down here just restores the columns/table
  // shape, empty, matching this migration's own up() in reverse.
  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.StockCountLocationMap') AND type = 'U')
CREATE TABLE log.StockCountLocationMap (
    MapId INT IDENTITY(1,1) NOT NULL
,   NamedLocation NVARCHAR(50) NOT NULL
,   StorageType NVARCHAR(3) NOT NULL
,   Bin NVARCHAR(10) NOT NULL
,   IsActive BIT NOT NULL DEFAULT 1
,   UpdatedBy NVARCHAR(100) NULL
,   UpdatedAtUtc DATETIME NOT NULL DEFAULT getutcdate()
,   CONSTRAINT PK_StockCountLocationMap PRIMARY KEY (MapId)
)`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'log.StockCountDocument') AND name = 'TicketNumber')
ALTER TABLE log.StockCountDocument ADD TicketNumber NVARCHAR(30) NULL`);

  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'log.StockCountLine') AND name = 'TicketNumber')
ALTER TABLE log.StockCountLine DROP COLUMN TicketNumber`);
};
