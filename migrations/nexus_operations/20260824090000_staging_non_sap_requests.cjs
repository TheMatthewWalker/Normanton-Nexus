'use strict';
// Staging Post: lets Production raise a request for a Non-SAP material (H&S
// equipment, tooling, consumables — anything with no SAP material code at
// all) alongside the existing SAP-material flow. See routes/staging.js's
// POST /requests and sql/migrate_staging_post.sql for the original workflow
// writeup (that file is historical now — see migrations/README.md — new
// Staging Post schema work goes here instead).
//
// Material NOT NULL -> NULL: a Non-SAP request has nothing to put there, so
// Material is now only required when IsNonSap = 0. MaterialText (already
// nullable — previously just a display-name snapshot alongside a real
// Material) doubles as the free-text description Production types for a
// Non-SAP request instead.

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'log.StagingRequest') AND name = 'IsNonSap')
ALTER TABLE log.StagingRequest ADD IsNonSap BIT NOT NULL CONSTRAINT DF_StagingRequest_IsNonSap DEFAULT (0)`);

  await knex.raw(`
IF COLUMNPROPERTY(OBJECT_ID(N'log.StagingRequest'), 'Material', 'AllowsNull') = 0
ALTER TABLE log.StagingRequest ALTER COLUMN Material NVARCHAR(18) NULL`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_StagingRequest_NonSap' AND parent_object_id = OBJECT_ID(N'log.StagingRequest'))
ALTER TABLE log.StagingRequest ADD CONSTRAINT CK_StagingRequest_NonSap CHECK (
  (IsNonSap = 0 AND Material IS NOT NULL) OR
  (IsNonSap = 1 AND Material IS NULL AND MaterialText IS NOT NULL)
)`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_StagingRequest_NonSap' AND parent_object_id = OBJECT_ID(N'log.StagingRequest'))
ALTER TABLE log.StagingRequest DROP CONSTRAINT CK_StagingRequest_NonSap`);

  // Any Non-SAP rows written while this migration was applied have no
  // Material to restore — NOT NULL can't go back on until they're dealt
  // with, so this only re-tightens the column when there's nothing to break.
  await knex.raw(`
IF COLUMNPROPERTY(OBJECT_ID(N'log.StagingRequest'), 'Material', 'AllowsNull') = 1
  AND NOT EXISTS (SELECT 1 FROM log.StagingRequest WHERE Material IS NULL)
ALTER TABLE log.StagingRequest ALTER COLUMN Material NVARCHAR(18) NOT NULL`);

  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'log.StagingRequest') AND name = 'IsNonSap')
ALTER TABLE log.StagingRequest DROP CONSTRAINT DF_StagingRequest_IsNonSap`);

  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'log.StagingRequest') AND name = 'IsNonSap')
ALTER TABLE log.StagingRequest DROP COLUMN IsNonSap`);
};
