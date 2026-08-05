'use strict';
// Billet staging / 96-hour shelf-life feature for Mixing tubs.
//
// Adds staging (into the 'Billet' room), return-to-Conditioning-Room, and
// supervisor expiry-scrap/expiry-override tracking to prod.MixingTubs, plus
// tub-level parent linking (prod.ProductionTrace.ParentTubID) so Extrusion
// traceability can reference a specific mixing tub rather than just a whole
// MixingID. See the approved plan for the full design rationale.
//
// Mix materials are confirmed not batch-managed in SAP — this is a
// portal-only (Normanton-Nexus) staging/traceability concept with no SAP
// batch/charge counterpart.

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
    // ── prod.MixingTubs: staging / scrap / expiry-override columns ──────────
    await knex.raw(`
IF COL_LENGTH('prod.MixingTubs', 'IsStaged') IS NULL
ALTER TABLE prod.MixingTubs ADD IsStaged BIT NOT NULL CONSTRAINT DF_MixingTubs_IsStaged DEFAULT (0)`);

    await knex.raw(`
IF COL_LENGTH('prod.MixingTubs', 'StagedAt') IS NULL
ALTER TABLE prod.MixingTubs ADD StagedAt DATETIME NULL`);

    await knex.raw(`
IF COL_LENGTH('prod.MixingTubs', 'ConditioningTimeHours') IS NULL
ALTER TABLE prod.MixingTubs ADD ConditioningTimeHours DECIMAL(6,2) NULL`);

    await knex.raw(`
IF COL_LENGTH('prod.MixingTubs', 'StagedByUserID') IS NULL
ALTER TABLE prod.MixingTubs ADD StagedByUserID INT NULL`);

    await knex.raw(`
IF COL_LENGTH('prod.MixingTubs', 'StagedQuantityKG') IS NULL
ALTER TABLE prod.MixingTubs ADD StagedQuantityKG DECIMAL(10,3) NULL`);

    await knex.raw(`
IF COL_LENGTH('prod.MixingTubs', 'IsScrapped') IS NULL
ALTER TABLE prod.MixingTubs ADD IsScrapped BIT NOT NULL CONSTRAINT DF_MixingTubs_IsScrapped DEFAULT (0)`);

    await knex.raw(`
IF COL_LENGTH('prod.MixingTubs', 'ScrappedAt') IS NULL
ALTER TABLE prod.MixingTubs ADD ScrappedAt DATETIME NULL`);

    await knex.raw(`
IF COL_LENGTH('prod.MixingTubs', 'ScrappedByUserID') IS NULL
ALTER TABLE prod.MixingTubs ADD ScrappedByUserID INT NULL`);

    await knex.raw(`
IF COL_LENGTH('prod.MixingTubs', 'ScrapReasonID') IS NULL
ALTER TABLE prod.MixingTubs ADD ScrapReasonID INT NULL`);

    await knex.raw(`
IF COL_LENGTH('prod.MixingTubs', 'ScrapMaterialDocumentSAP') IS NULL
ALTER TABLE prod.MixingTubs ADD ScrapMaterialDocumentSAP NVARCHAR(10) NULL`);

    await knex.raw(`
IF COL_LENGTH('prod.MixingTubs', 'ScrapSAPErrorMessage') IS NULL
ALTER TABLE prod.MixingTubs ADD ScrapSAPErrorMessage NVARCHAR(MAX) NULL`);

    await knex.raw(`
IF COL_LENGTH('prod.MixingTubs', 'ExpiryOverrideAt') IS NULL
ALTER TABLE prod.MixingTubs ADD ExpiryOverrideAt DATETIME NULL`);

    await knex.raw(`
IF COL_LENGTH('prod.MixingTubs', 'ExpiryOverrideByUserID') IS NULL
ALTER TABLE prod.MixingTubs ADD ExpiryOverrideByUserID INT NULL`);

    await knex.raw(`
IF COL_LENGTH('prod.MixingTubs', 'ExpiryOverrideReason') IS NULL
ALTER TABLE prod.MixingTubs ADD ExpiryOverrideReason NVARCHAR(500) NULL`);

    // FK to prod.ScrapReasons (that table itself has no cross-database
    // dependency, so this one's safe — unlike *ByUserID columns, which stay
    // unenforced everywhere in prod.* since PortalUsers lives in a different
    // database and SQL Server can't FK across databases).
    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_MixingTubs_ScrapReason')
ALTER TABLE prod.MixingTubs ADD CONSTRAINT FK_MixingTubs_ScrapReason FOREIGN KEY (ScrapReasonID) REFERENCES prod.ScrapReasons (ReasonID)`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_MixingTubs_Staging' AND object_id = OBJECT_ID('prod.MixingTubs'))
CREATE NONCLUSTERED INDEX IX_MixingTubs_Staging ON prod.MixingTubs (IsStaged, IsScrapped) INCLUDE (MixingID, TubSeq, TubWeightKG, StagedAt)`);

    // ── prod.MixingTubReturns: audit trail for partial/full returns to the
    //    Conditioning Room — the only thing that decrements StagedQuantityKG ──
    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.MixingTubReturns') AND type = 'U')
CREATE TABLE prod.MixingTubReturns (
    ReturnID INT IDENTITY(1,1) NOT NULL
,   TubID INT NOT NULL
,   QuantityKG DECIMAL(10,3) NOT NULL
,   ReturnedAt DATETIME NOT NULL
,   ReturnedByUserID INT NOT NULL
,   Notes NVARCHAR(500) NULL
,   CONSTRAINT PK_MixingTubReturns PRIMARY KEY (ReturnID)
)`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_MixingTubReturns_ReturnedAt')
ALTER TABLE prod.MixingTubReturns ADD CONSTRAINT DF_MixingTubReturns_ReturnedAt DEFAULT (getdate()) FOR ReturnedAt`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_MixingTubReturns_Qty')
ALTER TABLE prod.MixingTubReturns ADD CONSTRAINT CK_MixingTubReturns_Qty CHECK (QuantityKG > 0)`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_MixingTubReturns_Tub')
ALTER TABLE prod.MixingTubReturns ADD CONSTRAINT FK_MixingTubReturns_Tub FOREIGN KEY (TubID) REFERENCES prod.MixingTubs (TubID)`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_MixingTubReturns_Tub' AND object_id = OBJECT_ID('prod.MixingTubReturns'))
CREATE NONCLUSTERED INDEX IX_MixingTubReturns_Tub ON prod.MixingTubReturns (TubID) INCLUDE (QuantityKG, ReturnedAt)`);

    // ── prod.ProductionTrace: tub-level parent linking + BOM reporting ──────
    await knex.raw(`
IF COL_LENGTH('prod.ProductionTrace', 'ParentTubID') IS NULL
ALTER TABLE prod.ProductionTrace ADD ParentTubID INT NULL`);

    await knex.raw(`
IF COL_LENGTH('prod.ProductionTrace', 'ExpectedConsumptionKG') IS NULL
ALTER TABLE prod.ProductionTrace ADD ExpectedConsumptionKG DECIMAL(12,3) NULL`);

    await knex.raw(`
IF COL_LENGTH('prod.ProductionTrace', 'ReportedConsumptionKG') IS NULL
ALTER TABLE prod.ProductionTrace ADD ReportedConsumptionKG DECIMAL(12,3) NULL`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Trace_ParentTubOnlyForMX')
ALTER TABLE prod.ProductionTrace ADD CONSTRAINT CK_Trace_ParentTubOnlyForMX CHECK (ParentTubID IS NULL OR ParentProcessCode = N'MX')`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_ProductionTrace_ParentTub')
ALTER TABLE prod.ProductionTrace ADD CONSTRAINT FK_ProductionTrace_ParentTub FOREIGN KEY (ParentTubID) REFERENCES prod.MixingTubs (TubID)`);

    // Widen the existing 4-column uniqueness to include ParentTubID. SQL
    // Server treats two NULLs in the same composite unique-constraint tuple
    // as duplicates of each other (unlike ANSI NULL<>NULL semantics), so
    // every pre-existing non-MX-tub row (ParentTubID always NULL) keeps
    // exactly the same effective uniqueness as before, while distinct
    // non-null ParentTubID values now correctly distinguish multiple tubs
    // linked from the same MixingID.
    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'UQ_ProductionTrace' AND type = 'UQ')
ALTER TABLE prod.ProductionTrace DROP CONSTRAINT UQ_ProductionTrace`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'UQ_ProductionTrace' AND type = 'UQ')
ALTER TABLE prod.ProductionTrace ADD CONSTRAINT UQ_ProductionTrace UNIQUE (ChildProcessCode, ChildRecordID, ParentProcessCode, ParentRecordID, ParentTubID)`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Trace_ParentTub' AND object_id = OBJECT_ID('prod.ProductionTrace'))
CREATE NONCLUSTERED INDEX IX_Trace_ParentTub ON prod.ProductionTrace (ParentProcessCode, ParentTubID) WHERE ParentTubID IS NOT NULL`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
    // Reverse in dependency order.
    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Trace_ParentTub' AND object_id = OBJECT_ID('prod.ProductionTrace'))
DROP INDEX IX_Trace_ParentTub ON prod.ProductionTrace`);

    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'UQ_ProductionTrace' AND type = 'UQ')
ALTER TABLE prod.ProductionTrace DROP CONSTRAINT UQ_ProductionTrace`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'UQ_ProductionTrace' AND type = 'UQ')
ALTER TABLE prod.ProductionTrace ADD CONSTRAINT UQ_ProductionTrace UNIQUE (ChildProcessCode, ChildRecordID, ParentProcessCode, ParentRecordID)`);

    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_ProductionTrace_ParentTub')
ALTER TABLE prod.ProductionTrace DROP CONSTRAINT FK_ProductionTrace_ParentTub`);

    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Trace_ParentTubOnlyForMX')
ALTER TABLE prod.ProductionTrace DROP CONSTRAINT CK_Trace_ParentTubOnlyForMX`);

    await knex.raw(`
IF COL_LENGTH('prod.ProductionTrace', 'ReportedConsumptionKG') IS NOT NULL
ALTER TABLE prod.ProductionTrace DROP COLUMN ReportedConsumptionKG`);

    await knex.raw(`
IF COL_LENGTH('prod.ProductionTrace', 'ExpectedConsumptionKG') IS NOT NULL
ALTER TABLE prod.ProductionTrace DROP COLUMN ExpectedConsumptionKG`);

    await knex.raw(`
IF COL_LENGTH('prod.ProductionTrace', 'ParentTubID') IS NOT NULL
ALTER TABLE prod.ProductionTrace DROP COLUMN ParentTubID`);

    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.MixingTubReturns') AND type = 'U')
DROP TABLE prod.MixingTubReturns`);

    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_MixingTubs_Staging' AND object_id = OBJECT_ID('prod.MixingTubs'))
DROP INDEX IX_MixingTubs_Staging ON prod.MixingTubs`);

    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_MixingTubs_ScrapReason')
ALTER TABLE prod.MixingTubs DROP CONSTRAINT FK_MixingTubs_ScrapReason`);

    // DROP COLUMN fails while a named DEFAULT constraint still references the
    // column — drop those explicitly first (SQL Server does not auto-drop a
    // *named* default the way it does an unnamed one).
    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_MixingTubs_IsScrapped')
ALTER TABLE prod.MixingTubs DROP CONSTRAINT DF_MixingTubs_IsScrapped`);

    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_MixingTubs_IsStaged')
ALTER TABLE prod.MixingTubs DROP CONSTRAINT DF_MixingTubs_IsStaged`);

    const cols = [
        'ExpiryOverrideReason', 'ExpiryOverrideByUserID', 'ExpiryOverrideAt',
        'ScrapSAPErrorMessage', 'ScrapMaterialDocumentSAP', 'ScrapReasonID',
        'ScrappedByUserID', 'ScrappedAt', 'IsScrapped',
        'StagedQuantityKG', 'StagedByUserID', 'ConditioningTimeHours', 'StagedAt', 'IsStaged',
    ];
    for (const col of cols) {
        await knex.raw(`
IF COL_LENGTH('prod.MixingTubs', '${col}') IS NOT NULL
ALTER TABLE prod.MixingTubs DROP COLUMN ${col}`);
    }
};
