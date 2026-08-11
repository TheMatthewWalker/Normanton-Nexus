'use strict';
// log.MaterialRequestUnits — backs the Material Request Units admin tile
// (routes/materialRequestUnits.js) in Logistics Admin. Staging Post
// (routes/staging.js / sql/migrate_staging_post.sql's workflow) lets
// Production ask Stores for material in whatever unit they actually think
// in on the floor — "1 spool", "3 tubs" — rather than a raw KG figure no
// one on the production line would know offhand. This table is the
// conversion lookup that makes that possible: one row per
// (Material, Unit) pair, ConversionQty = how many KG one of that unit is
// (e.g. 30007R / Spool / 20 means 1 spool of 30007R = 20kg). A material can
// have several rows (different units), or none at all — Staging Post's
// request form falls back to the old direct-KG entry when a material has
// no configured units, so this is additive/opt-in per material rather than
// a hard requirement.
//
// Also adds RequestUnit / RequestUnitQty to log.StagingRequest: when a
// request is raised via a configured unit, these record what Production
// actually picked/typed ("1", "Spool") for display purposes, while the
// existing QuantityRequested/Uom columns keep holding the converted KG
// figure Stores and SAP work against unchanged — see routes/staging.js's
// POST /requests, which does the conversion server-side rather than
// trusting a client-computed KG figure.

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
  await knex.raw(`
    IF NOT EXISTS (SELECT 1 FROM sys.objects
                   WHERE object_id = OBJECT_ID(N'log.MaterialRequestUnits') AND type = 'U')
      CREATE TABLE log.MaterialRequestUnits (
        RequestUnitId  INT           NOT NULL IDENTITY(1,1),
        Material       NVARCHAR(18)  NOT NULL,
        Unit           NVARCHAR(20)  NOT NULL,
        ConversionQty  DECIMAL(15,3) NOT NULL,   -- KG equivalent of 1 Unit of Material
        CreatedBy      NVARCHAR(100) NULL,
        CreatedAtUtc   DATETIME      NOT NULL DEFAULT (GETUTCDATE()),
        UpdatedAtUtc   DATETIME      NULL,

        CONSTRAINT PK_MaterialRequestUnits PRIMARY KEY (RequestUnitId),
        CONSTRAINT UQ_MaterialRequestUnits_Material_Unit UNIQUE (Material, Unit),
        CONSTRAINT CK_MaterialRequestUnits_ConversionQty CHECK (ConversionQty > 0)
      )
  `);

  await knex.raw(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes
                   WHERE name = 'IX_MaterialRequestUnits_Material' AND object_id = OBJECT_ID(N'log.MaterialRequestUnits'))
      CREATE INDEX IX_MaterialRequestUnits_Material ON log.MaterialRequestUnits (Material)
  `);

  await knex.raw(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns
                   WHERE object_id = OBJECT_ID(N'log.StagingRequest') AND name = 'RequestUnit')
      ALTER TABLE log.StagingRequest ADD RequestUnit NVARCHAR(20) NULL
  `);

  await knex.raw(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns
                   WHERE object_id = OBJECT_ID(N'log.StagingRequest') AND name = 'RequestUnitQty')
      ALTER TABLE log.StagingRequest ADD RequestUnitQty DECIMAL(15,3) NULL
  `);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
  await knex.raw(`
    IF EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'log.StagingRequest') AND name = 'RequestUnitQty')
      ALTER TABLE log.StagingRequest DROP COLUMN RequestUnitQty
  `);
  await knex.raw(`
    IF EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'log.StagingRequest') AND name = 'RequestUnit')
      ALTER TABLE log.StagingRequest DROP COLUMN RequestUnit
  `);
  await knex.raw(`
    IF EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'log.MaterialRequestUnits') AND type = 'U')
      DROP TABLE log.MaterialRequestUnits
  `);
};
