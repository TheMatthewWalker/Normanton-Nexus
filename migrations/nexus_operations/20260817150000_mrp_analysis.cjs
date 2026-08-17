'use strict';
// MRP Analysis screen (Material Planning) — year-on-year consumption/goods-receipt trends
// per material, resolvable per vendor, plus two ways to turn a sales outlook into a
// raw-material purchasing number for next year (a %-increase extrapolation against past
// consumption, or a full sales-unit breakdown exploded down through SAP's multi-level BOM to
// raw materials). See routes/mrpanalysis.js and routes/performancesync.js's
// runMrpHistoryRefresh.
//
// MaterialConsumptionHistory/MaterialReceiptHistory are UPSERTED, not truncated (unlike
// log.TurnsValClassSnapshot) — they're meant to accumulate real year-on-year history, not
// reflect only the latest sync. Sourced from SapServer's new
// GET /api/mrp-analysis/consumption-by-year (MVER, reusing the existing 6-fiscal-year pull
// PerformanceHelpers.BuildConsumptionHistoryRequest already makes) and
// GET /api/mrp-analysis/goods-receipt-history (MSEG/MKPF + EKKO).
//
// MaterialReceiptHistory.VendorId is nullable and resolved by matching SapVendorNumber
// against log.Vendor.SapVendorNumber where possible — a PO against a vendor not yet in
// Nexus's Vendor table still gets a row (keyed by SapVendorNumber, its own PK component)
// rather than being silently dropped; VendorId is filled in only if/when that vendor is later
// added and the sync re-runs.
//
// MrpForecastRun rows are immutable snapshots (INSERT-only, never UPDATEd or overwritten) —
// per the user, re-running a forecast must produce a new dated run, not replace the old one,
// so estimates can be compared over time. MrpForecastRunMaterial is the per-material predicted
// raw-material output shared by both calculation methods; MrpForecastRunProduct is the
// sales-unit input, populated only for a 'BomBreakdown' run (kept for audit/traceability of
// what actually drove the result — a 'Percentage' run has nothing to store here).

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.MaterialConsumptionHistory') AND type = 'U')
CREATE TABLE log.MaterialConsumptionHistory (
    Material NVARCHAR(18) NOT NULL
,   Plant NVARCHAR(4) NOT NULL
,   FiscalYear INT NOT NULL
,   ConsumedQty DECIMAL(15,3) NOT NULL
,   LastUpdatedUtc DATETIME NOT NULL
,   CONSTRAINT PK_MaterialConsumptionHistory PRIMARY KEY (Material, Plant, FiscalYear)
)`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_MaterialConsumptionHistory_LastUpdatedUtc')
ALTER TABLE log.MaterialConsumptionHistory ADD CONSTRAINT DF_MaterialConsumptionHistory_LastUpdatedUtc DEFAULT (GETUTCDATE()) FOR LastUpdatedUtc`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.MaterialReceiptHistory') AND type = 'U')
CREATE TABLE log.MaterialReceiptHistory (
    Material NVARCHAR(18) NOT NULL
,   Plant NVARCHAR(4) NOT NULL
,   SapVendorNumber NVARCHAR(10) NOT NULL
,   VendorId INT NULL
,   FiscalYear INT NOT NULL
,   ReceivedQty DECIMAL(15,3) NOT NULL
,   Uom NVARCHAR(3) NULL
,   LastUpdatedUtc DATETIME NOT NULL
,   CONSTRAINT PK_MaterialReceiptHistory PRIMARY KEY (Material, Plant, SapVendorNumber, FiscalYear)
)`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_MaterialReceiptHistory_LastUpdatedUtc')
ALTER TABLE log.MaterialReceiptHistory ADD CONSTRAINT DF_MaterialReceiptHistory_LastUpdatedUtc DEFAULT (GETUTCDATE()) FOR LastUpdatedUtc`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_MaterialReceiptHistory_Vendor')
ALTER TABLE log.MaterialReceiptHistory ADD CONSTRAINT FK_MaterialReceiptHistory_Vendor FOREIGN KEY (VendorId) REFERENCES log.Vendor (VendorId)`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_MaterialReceiptHistory_Material' AND object_id = OBJECT_ID('log.MaterialReceiptHistory'))
CREATE NONCLUSTERED INDEX IX_MaterialReceiptHistory_Material ON log.MaterialReceiptHistory (Material) INCLUDE (VendorId, FiscalYear, ReceivedQty)`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.MrpForecastRun') AND type = 'U')
CREATE TABLE log.MrpForecastRun (
    RunId INT IDENTITY(1,1) NOT NULL
,   TargetYear INT NOT NULL
,   Method NVARCHAR(20) NOT NULL
,   BaselineYear INT NULL
,   PercentageChange DECIMAL(9,2) NULL
,   CreatedBy NVARCHAR(100) NULL
,   CreatedAtUtc DATETIME NOT NULL
,   CONSTRAINT PK_MrpForecastRun PRIMARY KEY (RunId)
)`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_MrpForecastRun_CreatedAtUtc')
ALTER TABLE log.MrpForecastRun ADD CONSTRAINT DF_MrpForecastRun_CreatedAtUtc DEFAULT (GETUTCDATE()) FOR CreatedAtUtc`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_MrpForecastRun_Method')
ALTER TABLE log.MrpForecastRun ADD CONSTRAINT CK_MrpForecastRun_Method CHECK (Method IN (N'Percentage', N'BomBreakdown'))`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_MrpForecastRun_TargetYear' AND object_id = OBJECT_ID('log.MrpForecastRun'))
CREATE NONCLUSTERED INDEX IX_MrpForecastRun_TargetYear ON log.MrpForecastRun (TargetYear) INCLUDE (Method, CreatedAtUtc)`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.MrpForecastRunMaterial') AND type = 'U')
CREATE TABLE log.MrpForecastRunMaterial (
    RunId INT NOT NULL
,   Material NVARCHAR(18) NOT NULL
,   PredictedQty DECIMAL(15,3) NOT NULL
,   Uom NVARCHAR(3) NULL
,   CONSTRAINT PK_MrpForecastRunMaterial PRIMARY KEY (RunId, Material)
)`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_MrpForecastRunMaterial_Run')
ALTER TABLE log.MrpForecastRunMaterial ADD CONSTRAINT FK_MrpForecastRunMaterial_Run FOREIGN KEY (RunId) REFERENCES log.MrpForecastRun (RunId)`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.MrpForecastRunProduct') AND type = 'U')
CREATE TABLE log.MrpForecastRunProduct (
    RunId INT NOT NULL
,   Material NVARCHAR(18) NOT NULL
,   ExpectedSalesUnits DECIMAL(15,3) NOT NULL
,   CONSTRAINT PK_MrpForecastRunProduct PRIMARY KEY (RunId, Material)
)`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_MrpForecastRunProduct_Run')
ALTER TABLE log.MrpForecastRunProduct ADD CONSTRAINT FK_MrpForecastRunProduct_Run FOREIGN KEY (RunId) REFERENCES log.MrpForecastRun (RunId)`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.MrpForecastRunProduct') AND type = 'U')
DROP TABLE log.MrpForecastRunProduct`);

  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.MrpForecastRunMaterial') AND type = 'U')
DROP TABLE log.MrpForecastRunMaterial`);

  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.MrpForecastRun') AND type = 'U')
DROP TABLE log.MrpForecastRun`);

  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_MaterialReceiptHistory_Material' AND object_id = OBJECT_ID('log.MaterialReceiptHistory'))
DROP INDEX IX_MaterialReceiptHistory_Material ON log.MaterialReceiptHistory`);

  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.MaterialReceiptHistory') AND type = 'U')
DROP TABLE log.MaterialReceiptHistory`);

  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.MaterialConsumptionHistory') AND type = 'U')
DROP TABLE log.MaterialConsumptionHistory`);
};
