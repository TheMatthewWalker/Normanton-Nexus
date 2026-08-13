'use strict';
// Stock Count feature — see the approved plan for full rationale. Four tables, all log.*
// (a fifth, StockCountLocationMap, was tried for the PTFE Weekly Cycle Count's named
// locations but replaced with free-typed bins validated live against SAP LAGP instead —
// see the PTFE_WEEKLY branch of routes/stockcount.js's resolveSapComparisonForLine):
//
// log.StockCountDocument — header row for PTFE_WEEKLY / RAW_MATERIAL / PRODUCTION counts
// (full submit -> finance-approve/reject -> 711/712-post lifecycle), and ALSO used as a
// lightweight active-session marker for FINISHED_GOODS (no lines/approval fields populated
// for that type — StockCountFgScan/StockCountDiscrepancy carry FG's actual data). Unifying
// FG's session tracking onto this same table means the transfer-request guard
// (lib/stockCountGuard.js) only ever has one table to check ("is there an active,
// non-PTFE_WEEKLY count for storage location X") regardless of count type.
//
// log.StockCountLine — one row per material x bin counted, for the three document-backed
// count types. Frozen-at-comparison-time SapQty/VarianceQty/VarianceValue/MaterialText/Uom
// (copied from log.TurnsValClassSnapshot at entry time, not joined live) so a count's figures
// can't silently drift if the snapshot or SAP stock changes after the fact — same rationale as
// log.IsoparDeclaration's CalculationSnapshotJson. IsInvalidMaterial is a denormalized flag
// (recomputed on every material-code correction) rather than a live join, so the "does this
// count have any invalid lines" completion gate is a single indexed lookup.
//
// log.StockCountFgScan — Finished Goods Count's scan audit trail. "Correct" is evaluated per
// the *scanned* bin against LQUA, not against one fixed "expected bin" — a batch legitimately
// present in more than one bin at once is handled without special-case code, per the approved
// plan's steer to treat that as an edge case rather than build dedicated multi-bin logic.
//
// log.StockCountDiscrepancy — the holding area feeding the new "Stock Count Discrepancies"
// panel inside the existing Stock Investigations tile. No FK to TurnsValClassSnapshot anywhere
// in this migration (it's truncate-and-reload daily — see PurchaseOrderSuggestion.ShipmentId
// for the established no-FK-across-snapshot-boundary convention this follows).

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
  // ── log.StockCountDocument ──────────────────────────────────────────────
  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.StockCountDocument') AND type = 'U')
CREATE TABLE log.StockCountDocument (
    CountId INT IDENTITY(1,1) NOT NULL
,   CountType NVARCHAR(20) NOT NULL
,   StorageLocation NVARCHAR(4) NULL
,   TicketNumber NVARCHAR(30) NULL
,   Status NVARCHAR(20) NOT NULL
,   WeekStartDate DATE NULL
,   CreatedBy NVARCHAR(100) NULL
,   CreatedByUserId INT NULL
,   CreatedAtUtc DATETIME NOT NULL
,   SubmittedBy NVARCHAR(100) NULL
,   SubmittedAtUtc DATETIME NULL
,   ApprovedBy NVARCHAR(100) NULL
,   ApprovedAtUtc DATETIME NULL
,   RejectedBy NVARCHAR(100) NULL
,   RejectedAtUtc DATETIME NULL
,   RejectionReason NVARCHAR(500) NULL
,   ReopenedBy NVARCHAR(100) NULL
,   ReopenedAtUtc DATETIME NULL
,   PostedByUserId INT NULL
,   PostedAtUtc DATETIME NULL
,   Notes NVARCHAR(1000) NULL
,   CONSTRAINT PK_StockCountDocument PRIMARY KEY (CountId)
)`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_StockCountDocument_CreatedAtUtc')
ALTER TABLE log.StockCountDocument ADD CONSTRAINT DF_StockCountDocument_CreatedAtUtc DEFAULT (getutcdate()) FOR CreatedAtUtc`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_StockCountDocument_Type')
ALTER TABLE log.StockCountDocument ADD CONSTRAINT CK_StockCountDocument_Type
  CHECK (CountType IN (N'PTFE_WEEKLY', N'RAW_MATERIAL', N'PRODUCTION', N'FINISHED_GOODS'))`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_StockCountDocument_Status')
ALTER TABLE log.StockCountDocument ADD CONSTRAINT CK_StockCountDocument_Status
  CHECK (Status IN (N'Open', N'PendingApproval', N'Approved', N'Rejected', N'Posted', N'Cancelled', N'Closed'))`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_StockCountDocument_PtfeWeek' AND object_id = OBJECT_ID('log.StockCountDocument'))
CREATE UNIQUE NONCLUSTERED INDEX UQ_StockCountDocument_PtfeWeek ON log.StockCountDocument (WeekStartDate)
  WHERE CountType = N'PTFE_WEEKLY' AND WeekStartDate IS NOT NULL`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_StockCountDocument_TypeLocationStatus' AND object_id = OBJECT_ID('log.StockCountDocument'))
CREATE NONCLUSTERED INDEX IX_StockCountDocument_TypeLocationStatus ON log.StockCountDocument (CountType, StorageLocation, Status)`);

  // ── log.StockCountLine ──────────────────────────────────────────────────
  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.StockCountLine') AND type = 'U')
CREATE TABLE log.StockCountLine (
    LineId INT IDENTITY(1,1) NOT NULL
,   CountId INT NOT NULL
,   Material NVARCHAR(18) NOT NULL
,   MaterialText NVARCHAR(80) NULL
,   Uom NVARCHAR(3) NULL
,   NamedLocation NVARCHAR(50) NULL
,   StorageType NVARCHAR(3) NULL
,   Bin NVARCHAR(10) NULL
,   CountedQty DECIMAL(15,3) NOT NULL
,   SapQty DECIMAL(15,3) NULL
,   VarianceQty DECIMAL(15,3) NULL
,   UnitPrice DECIMAL(15,4) NULL
,   VarianceValue DECIMAL(18,2) NULL
,   IsInvalidMaterial BIT NOT NULL
,   IsBatchManaged BIT NOT NULL
,   BinCompletedBy NVARCHAR(100) NULL
,   BinCompletedAtUtc DATETIME NULL
,   EnteredBy NVARCHAR(100) NOT NULL
,   EnteredAtUtc DATETIME NOT NULL
,   UpdatedAtUtc DATETIME NOT NULL
,   CONSTRAINT PK_StockCountLine PRIMARY KEY (LineId)
,   CONSTRAINT FK_StockCountLine_Document FOREIGN KEY (CountId) REFERENCES log.StockCountDocument (CountId)
)`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_StockCountLine_IsInvalidMaterial')
ALTER TABLE log.StockCountLine ADD CONSTRAINT DF_StockCountLine_IsInvalidMaterial DEFAULT (0) FOR IsInvalidMaterial`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_StockCountLine_IsBatchManaged')
ALTER TABLE log.StockCountLine ADD CONSTRAINT DF_StockCountLine_IsBatchManaged DEFAULT (0) FOR IsBatchManaged`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_StockCountLine_EnteredAtUtc')
ALTER TABLE log.StockCountLine ADD CONSTRAINT DF_StockCountLine_EnteredAtUtc DEFAULT (getutcdate()) FOR EnteredAtUtc`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_StockCountLine_UpdatedAtUtc')
ALTER TABLE log.StockCountLine ADD CONSTRAINT DF_StockCountLine_UpdatedAtUtc DEFAULT (getutcdate()) FOR UpdatedAtUtc`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_StockCountLine_Qty')
ALTER TABLE log.StockCountLine ADD CONSTRAINT CK_StockCountLine_Qty CHECK (CountedQty >= 0)`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_StockCountLine_CountId' AND object_id = OBJECT_ID('log.StockCountLine'))
CREATE NONCLUSTERED INDEX IX_StockCountLine_CountId ON log.StockCountLine (CountId)`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_StockCountLine_Material' AND object_id = OBJECT_ID('log.StockCountLine'))
CREATE NONCLUSTERED INDEX IX_StockCountLine_Material ON log.StockCountLine (Material)`);

  // ── log.StockCountFgScan ────────────────────────────────────────────────
  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.StockCountFgScan') AND type = 'U')
CREATE TABLE log.StockCountFgScan (
    ScanId INT IDENTITY(1,1) NOT NULL
,   Material NVARCHAR(18) NOT NULL
,   Batch NVARCHAR(10) NOT NULL
,   ExpectedFound BIT NOT NULL
,   ScannedStorageType NVARCHAR(3) NOT NULL
,   ScannedBin NVARCHAR(10) NOT NULL
,   Outcome NVARCHAR(20) NOT NULL
,   ScannedBy NVARCHAR(100) NOT NULL
,   ScannedAtUtc DATETIME NOT NULL
,   CONSTRAINT PK_StockCountFgScan PRIMARY KEY (ScanId)
)`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_StockCountFgScan_ScannedAtUtc')
ALTER TABLE log.StockCountFgScan ADD CONSTRAINT DF_StockCountFgScan_ScannedAtUtc DEFAULT (getutcdate()) FOR ScannedAtUtc`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_StockCountFgScan_Outcome')
ALTER TABLE log.StockCountFgScan ADD CONSTRAINT CK_StockCountFgScan_Outcome
  CHECK (Outcome IN (N'CorrectBin', N'WrongBin', N'MissingFromBin'))`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_StockCountFgScan_MaterialBatch' AND object_id = OBJECT_ID('log.StockCountFgScan'))
CREATE NONCLUSTERED INDEX IX_StockCountFgScan_MaterialBatch ON log.StockCountFgScan (Material, Batch)`);

  // ── log.StockCountDiscrepancy ───────────────────────────────────────────
  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.StockCountDiscrepancy') AND type = 'U')
CREATE TABLE log.StockCountDiscrepancy (
    DiscrepancyId INT IDENTITY(1,1) NOT NULL
,   Material NVARCHAR(18) NOT NULL
,   Batch NVARCHAR(10) NOT NULL
,   Kind NVARCHAR(20) NOT NULL
,   ExpectedStorageType NVARCHAR(3) NULL
,   ExpectedBin NVARCHAR(10) NULL
,   FoundStorageType NVARCHAR(3) NULL
,   FoundBin NVARCHAR(10) NULL
,   SourceScanId INT NULL
,   Status NVARCHAR(20) NOT NULL
,   ResolutionTransferOrderNumber NVARCHAR(10) NULL
,   ResolvedBy NVARCHAR(100) NULL
,   ResolvedAtUtc DATETIME NULL
,   CreatedAtUtc DATETIME NOT NULL
,   CONSTRAINT PK_StockCountDiscrepancy PRIMARY KEY (DiscrepancyId)
,   CONSTRAINT FK_StockCountDiscrepancy_Scan FOREIGN KEY (SourceScanId) REFERENCES log.StockCountFgScan (ScanId)
)`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_StockCountDiscrepancy_CreatedAtUtc')
ALTER TABLE log.StockCountDiscrepancy ADD CONSTRAINT DF_StockCountDiscrepancy_CreatedAtUtc DEFAULT (getutcdate()) FOR CreatedAtUtc`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_StockCountDiscrepancy_Kind')
ALTER TABLE log.StockCountDiscrepancy ADD CONSTRAINT CK_StockCountDiscrepancy_Kind
  CHECK (Kind IN (N'WrongBin', N'Missing'))`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_StockCountDiscrepancy_Status')
ALTER TABLE log.StockCountDiscrepancy ADD CONSTRAINT CK_StockCountDiscrepancy_Status
  CHECK (Status IN (N'Open', N'ResolvedMoved', N'ResolvedFoundLater', N'ResolvedHolding'))`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_StockCountDiscrepancy_OpenBatch' AND object_id = OBJECT_ID('log.StockCountDiscrepancy'))
CREATE UNIQUE NONCLUSTERED INDEX UQ_StockCountDiscrepancy_OpenBatch ON log.StockCountDiscrepancy (Material, Batch)
  WHERE Status = N'Open'`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_StockCountDiscrepancy_Status' AND object_id = OBJECT_ID('log.StockCountDiscrepancy'))
CREATE NONCLUSTERED INDEX IX_StockCountDiscrepancy_Status ON log.StockCountDiscrepancy (Status)`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.StockCountDiscrepancy') AND type = 'U')
DROP TABLE log.StockCountDiscrepancy`);

  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.StockCountFgScan') AND type = 'U')
DROP TABLE log.StockCountFgScan`);

  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.StockCountLine') AND type = 'U')
DROP TABLE log.StockCountLine`);

  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.StockCountDocument') AND type = 'U')
DROP TABLE log.StockCountDocument`);
};
