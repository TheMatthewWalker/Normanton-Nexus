'use strict';
// BOM-validated traceability for Convo/Braiding/TapeWrap/Coverline/Drumming
// (CO/BR/CL/TW/DR) — NOT Extrusion/Mixing (EX/MX), which keep their existing
// separate MX-tub-staging-aware check (validateMxTubLinks in
// routes/productionnexus.js). See the approved plan for full rationale.
//
// prod.ProductionBom — a BOM snapshot saved into a job the moment its
// material is known (persisted, not just a live SAP call each time), so
// "what BOM was this job built against" survives even if SAP's BOM changes
// later. Append-only: a "Refresh BOM" action inserts a NEW batch
// (DownloadedAt) rather than overwriting the original, so the
// creation-time snapshot stays intact for audit while the latest batch
// (MAX(DownloadedAt) per ProcessCode+RecordID) is what validation uses
// going forward.
//
// prod.TraceabilityConcessions — a Production-raised, Quality-approved
// exception to a BOM mismatch. Approving one lets the job's completion
// proceed, but re-routes that job's SAP posting away from the normal
// automatic BOM-driven backflush to an explicit goods-movement post (see
// SapServer's new goods-movement-backflush endpoint) naming the actual
// component consumed instead of what the BOM expected.

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
    // ── prod.ProductionBom ──────────────────────────────────────────────────
    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.ProductionBom') AND type = 'U')
CREATE TABLE prod.ProductionBom (
    BomID INT IDENTITY(1,1) NOT NULL
,   ProcessCode NVARCHAR(5) NOT NULL
,   RecordID INT NOT NULL
,   Material NVARCHAR(18) NOT NULL
,   Component NVARCHAR(18) NOT NULL
,   Item NVARCHAR(4) NULL
,   ComponentQty DECIMAL(12,4) NULL
,   ComponentUnit NVARCHAR(3) NULL
,   StorageLocation NVARCHAR(4) NULL
,   DownloadedAt DATETIME NOT NULL
,   CONSTRAINT PK_ProductionBom PRIMARY KEY (BomID)
)`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_ProductionBom_DownloadedAt')
ALTER TABLE prod.ProductionBom ADD CONSTRAINT DF_ProductionBom_DownloadedAt DEFAULT (getdate()) FOR DownloadedAt`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_ProductionBom_ProcessCode')
ALTER TABLE prod.ProductionBom ADD CONSTRAINT CK_ProductionBom_ProcessCode
  CHECK (ProcessCode IN (N'CO', N'BR', N'CL', N'TW', N'DR'))`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ProductionBom_Job' AND object_id = OBJECT_ID('prod.ProductionBom'))
CREATE NONCLUSTERED INDEX IX_ProductionBom_Job ON prod.ProductionBom (ProcessCode, RecordID, DownloadedAt) INCLUDE (Component, ComponentQty, ComponentUnit)`);

    // ── prod.TraceabilityConcessions ────────────────────────────────────────
    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.TraceabilityConcessions') AND type = 'U')
CREATE TABLE prod.TraceabilityConcessions (
    ConcessionID INT IDENTITY(1,1) NOT NULL
,   ProcessCode NVARCHAR(5) NOT NULL
,   RecordID INT NOT NULL
,   ParentProcessCode NVARCHAR(5) NOT NULL
,   ParentRecordID INT NOT NULL
,   Component NVARCHAR(18) NOT NULL
,   ActualMaterial NVARCHAR(18) NOT NULL
,   Quantity DECIMAL(12,4) NULL
,   Reason NVARCHAR(500) NOT NULL
,   Status NVARCHAR(20) NOT NULL
,   RaisedByUserID INT NOT NULL
,   RaisedAt DATETIME NOT NULL
,   ReviewedByUserID INT NULL
,   ReviewedAt DATETIME NULL
,   ReviewNotes NVARCHAR(500) NULL
,   AppliedAt DATETIME NULL
,   MaterialDocumentSAP NVARCHAR(10) NULL
,   CONSTRAINT PK_TraceabilityConcessions PRIMARY KEY (ConcessionID)
)`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_TraceabilityConcessions_Status')
ALTER TABLE prod.TraceabilityConcessions ADD CONSTRAINT DF_TraceabilityConcessions_Status DEFAULT (N'PENDING') FOR Status`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_TraceabilityConcessions_RaisedAt')
ALTER TABLE prod.TraceabilityConcessions ADD CONSTRAINT DF_TraceabilityConcessions_RaisedAt DEFAULT (getdate()) FOR RaisedAt`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_TraceabilityConcessions_ProcessCode')
ALTER TABLE prod.TraceabilityConcessions ADD CONSTRAINT CK_TraceabilityConcessions_ProcessCode
  CHECK (ProcessCode IN (N'CO', N'BR', N'CL', N'TW', N'DR'))`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_TraceabilityConcessions_Status')
ALTER TABLE prod.TraceabilityConcessions ADD CONSTRAINT CK_TraceabilityConcessions_Status
  CHECK (Status IN (N'PENDING', N'APPROVED', N'REJECTED'))`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TraceabilityConcessions_Job' AND object_id = OBJECT_ID('prod.TraceabilityConcessions'))
CREATE NONCLUSTERED INDEX IX_TraceabilityConcessions_Job ON prod.TraceabilityConcessions (ProcessCode, RecordID, Status) INCLUDE (ParentProcessCode, ParentRecordID, Component)`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TraceabilityConcessions_Job' AND object_id = OBJECT_ID('prod.TraceabilityConcessions'))
DROP INDEX IX_TraceabilityConcessions_Job ON prod.TraceabilityConcessions`);

    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.TraceabilityConcessions') AND type = 'U')
DROP TABLE prod.TraceabilityConcessions`);

    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ProductionBom_Job' AND object_id = OBJECT_ID('prod.ProductionBom'))
DROP INDEX IX_ProductionBom_Job ON prod.ProductionBom`);

    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'prod.ProductionBom') AND type = 'U')
DROP TABLE prod.ProductionBom`);
};
