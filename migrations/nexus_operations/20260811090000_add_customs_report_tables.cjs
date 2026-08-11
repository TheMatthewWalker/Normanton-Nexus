'use strict';
// CustomsVatNumberOverrides / CustomsHsCodeDescriptions — backs the French
// VAT / DDP Customs Report tile (routes/customsreport.js +
// routes/customsreportadmin.js). Logistics admin/reference data, so it
// lands in NexusOperations' .log schema (not Nexus, which is reserved for
// portal auth/session/permissions/scheduling). Originally applied to the
// live kongsberg database via sql/migrate_customs_report_tables.sql, run
// independently of (and after) the 20260804120000_initial_schema.cjs DDL
// extraction, so that snapshot missed them — added here as its own
// migration once the gap was found while auditing every route file's table
// references ahead of the pool-getter refactor (config.js's
// getNexusOperationsPool()).

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
  await knex.raw(`
    IF NOT EXISTS (SELECT 1 FROM sys.objects
                   WHERE object_id = OBJECT_ID(N'log.CustomsVatNumberOverrides') AND type = 'U')
      CREATE TABLE log.CustomsVatNumberOverrides (
        OverrideId     INT           NOT NULL IDENTITY(1,1),
        ConsigneeCode  NVARCHAR(10)  NOT NULL,
        VatNumber      NVARCHAR(20)  NOT NULL,
        Notes          NVARCHAR(200) NULL,
        CreatedBy      NVARCHAR(100) NULL,
        CreatedAtUtc   DATETIME      NOT NULL DEFAULT (GETUTCDATE()),
        UpdatedAtUtc   DATETIME      NULL,

        CONSTRAINT PK_CustomsVatNumberOverrides PRIMARY KEY (OverrideId),
        CONSTRAINT UQ_CustomsVatNumberOverrides_Consignee UNIQUE (ConsigneeCode)
      )
  `);

  await knex.raw(`
    IF NOT EXISTS (SELECT 1 FROM sys.objects
                   WHERE object_id = OBJECT_ID(N'log.CustomsHsCodeDescriptions') AND type = 'U')
      CREATE TABLE log.CustomsHsCodeDescriptions (
        HsCodeId       INT           NOT NULL IDENTITY(1,1),
        CommodityCode  NVARCHAR(10)  NOT NULL,
        Description    NVARCHAR(400) NOT NULL,
        CreatedBy      NVARCHAR(100) NULL,
        CreatedAtUtc   DATETIME      NOT NULL DEFAULT (GETUTCDATE()),
        UpdatedAtUtc   DATETIME      NULL,

        CONSTRAINT PK_CustomsHsCodeDescriptions PRIMARY KEY (HsCodeId),
        CONSTRAINT UQ_CustomsHsCodeDescriptions_Code UNIQUE (CommodityCode)
      )
  `);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
  await knex.raw(`
    IF EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'log.CustomsHsCodeDescriptions') AND type = 'U')
      DROP TABLE log.CustomsHsCodeDescriptions
  `);
  await knex.raw(`
    IF EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'log.CustomsVatNumberOverrides') AND type = 'U')
      DROP TABLE log.CustomsVatNumberOverrides
  `);
};
