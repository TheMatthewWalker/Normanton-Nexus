'use strict';
// Isopar (Material 10010) is stored in a tank with no SAP-trustworthy stock
// figure, and Kongsberg has a legal duty to declare its Tied Oil consumption
// to HMRC every 3 months under the licensing scheme. See the approved plan
// for full rationale. Three tables, all log.* (this material's planning and
// receipts already live under log.* — VendorMaterial, PurchaseOrderSuggestion):
//
// log.IsoparMeterReading — one manually-entered tank-level reading per day.
// Becomes Isopar's "current stock" for MRP planning (routes/performance.js),
// replacing log.TurnsValClassSnapshot.StockQty/ConsignmentQty for this one
// material. Freely editable/deletable — see log.IsoparDeclaration below for
// why that's safe.
//
// log.IsoparPlanningRate — the weekday/weekend L/day planning assumption
// used to forecast Isopar's stock forward (replacing SAP's PredictedUsage
// for this material). Versioned/append-only rather than a single mutable
// row: "current" is simply the most recent row by RateId, so every change
// (a manual edit, or one-click-applying a system recommendation) leaves a
// free audit trail with no extra bookkeeping. Seeded with one row so
// "current rate" always resolves, even before anyone touches the UI.
//
// log.IsoparDeclaration — one frozen row per submitted HMRC Tied Oil
// declaration (fixed 3-month periods, see routes/isoparPeriods.js).
// OpeningStockQty/ClosingStockQty/ReceivedQty/ConsumedQty are stored
// verbatim at submit time (app-computed, not SQL computed columns) and
// never recalculated afterward — editing a log.IsoparMeterReading row later
// must NOT change a declaration that already cited it. OpeningReadingId/
// ClosingReadingId record which reading rows were used, purely for audit
// (no FK, matching this schema's general no-FK convention for this kind of
// cross-reference — see PurchaseOrderSuggestion.ShipmentId). The
// reconciliation CHECK (Opening+Received = Consumed+Closing) is an exact
// equality since every figure is DECIMAL, not floating point.

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
    // ── log.IsoparMeterReading ───────────────────────────────────────────────
    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.IsoparMeterReading') AND type = 'U')
CREATE TABLE log.IsoparMeterReading (
    ReadingId INT IDENTITY(1,1) NOT NULL
,   ReadingDate DATETIME NOT NULL
,   ReadingQty DECIMAL(15,3) NOT NULL
,   Notes NVARCHAR(500) NULL
,   CreatedBy NVARCHAR(100) NULL
,   CreatedAtUtc DATETIME NOT NULL
,   UpdatedAtUtc DATETIME NOT NULL
,   CONSTRAINT PK_IsoparMeterReading PRIMARY KEY (ReadingId)
)`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_IsoparMeterReading_CreatedAtUtc')
ALTER TABLE log.IsoparMeterReading ADD CONSTRAINT DF_IsoparMeterReading_CreatedAtUtc DEFAULT (getutcdate()) FOR CreatedAtUtc`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_IsoparMeterReading_UpdatedAtUtc')
ALTER TABLE log.IsoparMeterReading ADD CONSTRAINT DF_IsoparMeterReading_UpdatedAtUtc DEFAULT (getutcdate()) FOR UpdatedAtUtc`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_IsoparMeterReading_NonNegative')
ALTER TABLE log.IsoparMeterReading ADD CONSTRAINT CK_IsoparMeterReading_NonNegative
  CHECK (ReadingQty >= 0)`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_IsoparMeterReading_ReadingDate' AND object_id = OBJECT_ID('log.IsoparMeterReading'))
CREATE UNIQUE NONCLUSTERED INDEX UQ_IsoparMeterReading_ReadingDate ON log.IsoparMeterReading (ReadingDate)`);

    // ── log.IsoparPlanningRate ───────────────────────────────────────────────
    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.IsoparPlanningRate') AND type = 'U')
CREATE TABLE log.IsoparPlanningRate (
    RateId INT IDENTITY(1,1) NOT NULL
,   WeekdayRateLPerDay DECIMAL(9,2) NOT NULL
,   WeekendRateLPerDay DECIMAL(9,2) NOT NULL
,   Source NVARCHAR(20) NOT NULL
,   Notes NVARCHAR(500) NULL
,   CreatedBy NVARCHAR(100) NULL
,   CreatedAtUtc DATETIME NOT NULL
,   CONSTRAINT PK_IsoparPlanningRate PRIMARY KEY (RateId)
)`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_IsoparPlanningRate_CreatedAtUtc')
ALTER TABLE log.IsoparPlanningRate ADD CONSTRAINT DF_IsoparPlanningRate_CreatedAtUtc DEFAULT (getutcdate()) FOR CreatedAtUtc`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_IsoparPlanningRate_NonNegative')
ALTER TABLE log.IsoparPlanningRate ADD CONSTRAINT CK_IsoparPlanningRate_NonNegative
  CHECK (WeekdayRateLPerDay >= 0 AND WeekendRateLPerDay >= 0)`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_IsoparPlanningRate_Source')
ALTER TABLE log.IsoparPlanningRate ADD CONSTRAINT CK_IsoparPlanningRate_Source
  CHECK (Source IN (N'Manual', N'Recommended'))`);

    // Default planning rate at go-live — 450 L/day weekdays, 50 L/day weekends
    // (Kongsberg's own stated planning assumption) — guarantees "current rate"
    // always resolves to something, even before anyone opens the settings UI.
    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM log.IsoparPlanningRate)
INSERT INTO log.IsoparPlanningRate (WeekdayRateLPerDay, WeekendRateLPerDay, Source, Notes, CreatedBy)
VALUES (450.00, 50.00, N'Manual', N'Initial default rate at go-live', N'system')`);

    // ── log.IsoparDeclaration ────────────────────────────────────────────────
    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.IsoparDeclaration') AND type = 'U')
CREATE TABLE log.IsoparDeclaration (
    DeclarationId INT IDENTITY(1,1) NOT NULL
,   PeriodStart DATETIME NOT NULL
,   PeriodEnd DATETIME NOT NULL
,   OpeningStockQty DECIMAL(15,3) NOT NULL
,   ReceivedQty DECIMAL(15,3) NOT NULL
,   ClosingStockQty DECIMAL(15,3) NOT NULL
,   ConsumedQty DECIMAL(15,3) NOT NULL
,   OpeningReadingId INT NULL
,   ClosingReadingId INT NULL
,   CalculationSnapshotJson NVARCHAR(MAX) NULL
,   Notes NVARCHAR(1000) NULL
,   SubmittedByUserId INT NOT NULL
,   SubmittedByUsername NVARCHAR(80) NULL
,   SubmittedAtUtc DATETIME NOT NULL
,   CONSTRAINT PK_IsoparDeclaration PRIMARY KEY (DeclarationId)
)`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_IsoparDeclaration_SubmittedAtUtc')
ALTER TABLE log.IsoparDeclaration ADD CONSTRAINT DF_IsoparDeclaration_SubmittedAtUtc DEFAULT (getutcdate()) FOR SubmittedAtUtc`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_IsoparDeclaration_PeriodRange')
ALTER TABLE log.IsoparDeclaration ADD CONSTRAINT CK_IsoparDeclaration_PeriodRange
  CHECK (PeriodEnd > PeriodStart)`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_IsoparDeclaration_NonNegative')
ALTER TABLE log.IsoparDeclaration ADD CONSTRAINT CK_IsoparDeclaration_NonNegative
  CHECK (OpeningStockQty >= 0 AND ReceivedQty >= 0 AND ClosingStockQty >= 0)`);

    // Deliberately NOT constraining ConsumedQty >= 0 — a meter misread can make
    // Closing > Opening+Received, which HMRC still needs reported as-is rather
    // than silently blocked (see the approved plan's negative-ConsumedQty decision).
    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_IsoparDeclaration_Reconciliation')
ALTER TABLE log.IsoparDeclaration ADD CONSTRAINT CK_IsoparDeclaration_Reconciliation
  CHECK (OpeningStockQty + ReceivedQty = ConsumedQty + ClosingStockQty)`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_IsoparDeclaration_Period' AND object_id = OBJECT_ID('log.IsoparDeclaration'))
CREATE UNIQUE NONCLUSTERED INDEX UQ_IsoparDeclaration_Period ON log.IsoparDeclaration (PeriodStart, PeriodEnd)`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_IsoparDeclaration_PeriodStart' AND object_id = OBJECT_ID('log.IsoparDeclaration'))
CREATE NONCLUSTERED INDEX IX_IsoparDeclaration_PeriodStart ON log.IsoparDeclaration (PeriodStart)`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_IsoparDeclaration_PeriodStart' AND object_id = OBJECT_ID('log.IsoparDeclaration'))
DROP INDEX IX_IsoparDeclaration_PeriodStart ON log.IsoparDeclaration`);

    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_IsoparDeclaration_Period' AND object_id = OBJECT_ID('log.IsoparDeclaration'))
DROP INDEX UQ_IsoparDeclaration_Period ON log.IsoparDeclaration`);

    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.IsoparDeclaration') AND type = 'U')
DROP TABLE log.IsoparDeclaration`);

    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.IsoparPlanningRate') AND type = 'U')
DROP TABLE log.IsoparPlanningRate`);

    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_IsoparMeterReading_ReadingDate' AND object_id = OBJECT_ID('log.IsoparMeterReading'))
DROP INDEX UQ_IsoparMeterReading_ReadingDate ON log.IsoparMeterReading`);

    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.IsoparMeterReading') AND type = 'U')
DROP TABLE log.IsoparMeterReading`);
};
