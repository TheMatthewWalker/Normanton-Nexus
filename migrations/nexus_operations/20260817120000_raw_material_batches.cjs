'use strict';
// Some BOM components are raw materials (SAP profit centre 2012) rather
// than a portal-tracked semi-finished material — there's no
// prod.Mixing/Extrusion/etc. record to resolve a batch against for these,
// since Normanton-Nexus never produced them. Traceability for a raw
// material component is a hand-written SAP batch number the operator types
// directly (see routes/productionnexus.js's RAW_MATERIAL_PROFIT_CENTRE),
// not a {processCode, recordID} link — hence a separate table rather than
// trying to retrofit prod.ProductionTrace (whose ParentProcessCode/
// ParentRecordID/unique-constraint shape assumes a real portal record
// always exists to link to).
//
// prod.ProductionBom.ProfitCentre is persisted at BOM-download time (one
// bulk SAP call per download/refresh — see fetchProfitCentres) so
// "raw material or not" is known from the saved snapshot without
// re-querying SAP on every validation.

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
    await knex.raw(`
IF COL_LENGTH('prod.ProductionBom', 'ProfitCentre') IS NULL
ALTER TABLE prod.ProductionBom ADD ProfitCentre NVARCHAR(10) NULL`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.RawMaterialBatches') AND type = 'U')
CREATE TABLE prod.RawMaterialBatches (
    BatchID INT IDENTITY(1,1) NOT NULL
,   ProcessCode NVARCHAR(5) NOT NULL
,   RecordID INT NOT NULL
,   Material NVARCHAR(18) NOT NULL
,   BatchNumber NVARCHAR(50) NOT NULL
,   LinkedAt DATETIME NOT NULL
,   LinkedByUserID INT NOT NULL
,   CONSTRAINT PK_RawMaterialBatches PRIMARY KEY (BatchID)
)`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_RawMaterialBatches_LinkedAt')
ALTER TABLE prod.RawMaterialBatches ADD CONSTRAINT DF_RawMaterialBatches_LinkedAt DEFAULT (getdate()) FOR LinkedAt`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_RawMaterialBatches_ProcessCode')
ALTER TABLE prod.RawMaterialBatches ADD CONSTRAINT CK_RawMaterialBatches_ProcessCode
  CHECK (ProcessCode IN (N'CO', N'BR', N'CL', N'TW', N'DR'))`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_RawMaterialBatches_Job' AND object_id = OBJECT_ID('prod.RawMaterialBatches'))
CREATE NONCLUSTERED INDEX IX_RawMaterialBatches_Job ON prod.RawMaterialBatches (ProcessCode, RecordID) INCLUDE (Material, BatchNumber)`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_RawMaterialBatches_Job' AND object_id = OBJECT_ID('prod.RawMaterialBatches'))
DROP INDEX IX_RawMaterialBatches_Job ON prod.RawMaterialBatches`);

    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.RawMaterialBatches') AND type = 'U')
DROP TABLE prod.RawMaterialBatches`);

    await knex.raw(`
IF COL_LENGTH('prod.ProductionBom', 'ProfitCentre') IS NOT NULL
ALTER TABLE prod.ProductionBom DROP COLUMN ProfitCentre`);
};
