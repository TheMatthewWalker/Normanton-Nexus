/* ============================================================
   Production DB migration v6
   - Batch ref format: remove dash separator  (MX-00000001 → MX00000001)
   - EXT ProcessCode → EX  (EXT-00000001 → EX00000001, all 10 chars)
   Run connected to the Production database.
   ============================================================ */

/* ── 1. Drop all ProcessCode CHECK constraints first ────────────────────── */

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name=N'CK_WorkCentres_ProcCode'  AND parent_object_id=OBJECT_ID(N'prod.WorkCentres'))
    ALTER TABLE prod.WorkCentres     DROP CONSTRAINT CK_WorkCentres_ProcCode

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name=N'CK_BatchOp_ProcessCode'  AND parent_object_id=OBJECT_ID(N'prod.BatchOperators'))
    ALTER TABLE prod.BatchOperators  DROP CONSTRAINT CK_BatchOp_ProcessCode

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name=N'CK_Trace_ChildCode'      AND parent_object_id=OBJECT_ID(N'prod.ProductionTrace'))
    ALTER TABLE prod.ProductionTrace DROP CONSTRAINT CK_Trace_ChildCode

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name=N'CK_Trace_ParentCode'     AND parent_object_id=OBJECT_ID(N'prod.ProductionTrace'))
    ALTER TABLE prod.ProductionTrace DROP CONSTRAINT CK_Trace_ParentCode

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name=N'CK_Scrap_ProcessCode'    AND parent_object_id=OBJECT_ID(N'prod.ScrapEntries'))
    ALTER TABLE prod.ScrapEntries    DROP CONSTRAINT CK_Scrap_ProcessCode

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name=N'CK_SAPPost_ProcessCode'  AND parent_object_id=OBJECT_ID(N'prod.SAPPostings'))
    ALTER TABLE prod.SAPPostings     DROP CONSTRAINT CK_SAPPost_ProcessCode

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name=N'CK_EventLog_ProcessCode' AND parent_object_id=OBJECT_ID(N'prod.EventLog'))
    ALTER TABLE prod.EventLog        DROP CONSTRAINT CK_EventLog_ProcessCode


/* ── 2. Migrate EXT → EX in all data ───────────────────────────────────── */

UPDATE prod.WorkCentres     SET ProcessCode       = N'EX' WHERE ProcessCode       = N'EXT'
UPDATE prod.BatchOperators  SET ProcessCode       = N'EX' WHERE ProcessCode       = N'EXT'
UPDATE prod.ProductionTrace SET ChildProcessCode  = N'EX' WHERE ChildProcessCode  = N'EXT'
UPDATE prod.ProductionTrace SET ParentProcessCode = N'EX' WHERE ParentProcessCode = N'EXT'
UPDATE prod.ScrapEntries    SET ProcessCode       = N'EX' WHERE ProcessCode       = N'EXT'
UPDATE prod.SAPPostings     SET ProcessCode       = N'EX' WHERE ProcessCode       = N'EXT'
UPDATE prod.EventLog        SET ProcessCode       = N'EX' WHERE ProcessCode       = N'EXT'

IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id=OBJECT_ID(N'prod.BackflushAlerts') AND type='U')
    UPDATE prod.BackflushAlerts SET ProcessCode   = N'EX' WHERE ProcessCode       = N'EXT'


/* ── 3. Recreate CHECK constraints with EX (no EXT) ────────────────────── */

ALTER TABLE prod.WorkCentres ADD CONSTRAINT CK_WorkCentres_ProcCode
    CHECK (ProcessCode IN (N'MX',N'EX',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'HA',N'PV'))

ALTER TABLE prod.BatchOperators ADD CONSTRAINT CK_BatchOp_ProcessCode
    CHECK (ProcessCode IN (N'MX',N'EX',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'FW',N'HA',N'PV'))

ALTER TABLE prod.ProductionTrace ADD CONSTRAINT CK_Trace_ChildCode
    CHECK (ChildProcessCode IN (N'MX',N'EX',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'FW',N'HA',N'PV'))

ALTER TABLE prod.ProductionTrace ADD CONSTRAINT CK_Trace_ParentCode
    CHECK (ParentProcessCode IN (N'MX',N'EX',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'FW',N'HA',N'PV'))

ALTER TABLE prod.ScrapEntries ADD CONSTRAINT CK_Scrap_ProcessCode
    CHECK (ProcessCode IN (N'MX',N'EX',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'FW',N'HA',N'PV'))

ALTER TABLE prod.SAPPostings ADD CONSTRAINT CK_SAPPost_ProcessCode
    CHECK (ProcessCode IN (N'MX',N'EX',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'FW',N'HA',N'PV'))

ALTER TABLE prod.EventLog ADD CONSTRAINT CK_EventLog_ProcessCode
    CHECK (ProcessCode IN (N'MX',N'EX',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'FW',N'HA',N'PV'))


/* ── 4. Recreate computed ref columns without dash ──────────────────────── */

/* prod.Mixing — MX00000001 */
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Mixing') AND name=N'UQ_Mixing_MixRef')    DROP INDEX UQ_Mixing_MixRef   ON prod.Mixing
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Mixing') AND name=N'IX_Mixing_Status')    DROP INDEX IX_Mixing_Status   ON prod.Mixing
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Mixing') AND name=N'IX_Mixing_CreatedAt') DROP INDEX IX_Mixing_CreatedAt ON prod.Mixing
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.Mixing') AND name=N'MixRef')
    ALTER TABLE prod.Mixing DROP COLUMN MixRef
ALTER TABLE prod.Mixing ADD MixRef AS (CAST(N'MX' + RIGHT('00000000' + CAST(MixingID AS VARCHAR(8)), 8) AS NVARCHAR(10))) PERSISTED
CREATE UNIQUE INDEX UQ_Mixing_MixRef   ON prod.Mixing (MixRef)
CREATE INDEX IX_Mixing_Status          ON prod.Mixing (Status)    INCLUDE (MixRef, Material, CreatedAt)
CREATE INDEX IX_Mixing_CreatedAt       ON prod.Mixing (CreatedAt) INCLUDE (MixRef, Material, Status)

/* prod.Extrusion — EX00000001  (EXT → EX prefix) */
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Extrusion') AND name=N'UQ_Extrusion_ExtRef')    DROP INDEX UQ_Extrusion_ExtRef    ON prod.Extrusion
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Extrusion') AND name=N'IX_Extrusion_Status')    DROP INDEX IX_Extrusion_Status    ON prod.Extrusion
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Extrusion') AND name=N'IX_Extrusion_CreatedAt') DROP INDEX IX_Extrusion_CreatedAt ON prod.Extrusion
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.Extrusion') AND name=N'ExtRef')
    ALTER TABLE prod.Extrusion DROP COLUMN ExtRef
ALTER TABLE prod.Extrusion ADD ExtRef AS (CAST(N'EX' + RIGHT('00000000' + CAST(ExtrusionID AS VARCHAR(8)), 8) AS NVARCHAR(10))) PERSISTED
CREATE UNIQUE INDEX UQ_Extrusion_ExtRef   ON prod.Extrusion (ExtRef)
CREATE INDEX IX_Extrusion_Status          ON prod.Extrusion (Status)    INCLUDE (ExtRef, Material, CreatedAt)
CREATE INDEX IX_Extrusion_CreatedAt       ON prod.Extrusion (CreatedAt) INCLUDE (ExtRef, Material, Status)

/* prod.Convoluting — CO00000001 */
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Convoluting') AND name=N'UQ_Convo_ConvRef')    DROP INDEX UQ_Convo_ConvRef    ON prod.Convoluting
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Convoluting') AND name=N'IX_Convo_Status')     DROP INDEX IX_Convo_Status     ON prod.Convoluting
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Convoluting') AND name=N'IX_Convo_CreatedAt')  DROP INDEX IX_Convo_CreatedAt  ON prod.Convoluting
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.Convoluting') AND name=N'ConvRef')
    ALTER TABLE prod.Convoluting DROP COLUMN ConvRef
ALTER TABLE prod.Convoluting ADD ConvRef AS (CAST(N'CO' + RIGHT('00000000' + CAST(ConvolutingID AS VARCHAR(8)), 8) AS NVARCHAR(10))) PERSISTED
CREATE UNIQUE INDEX UQ_Convo_ConvRef   ON prod.Convoluting (ConvRef)
CREATE INDEX IX_Convo_Status           ON prod.Convoluting (Status)    INCLUDE (ConvRef, Material, CreatedAt)
CREATE INDEX IX_Convo_CreatedAt        ON prod.Convoluting (CreatedAt) INCLUDE (ConvRef, Material, Status)

/* prod.Braiding — BR00000001 */
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Braiding') AND name=N'UQ_Braiding_BraidRef')   DROP INDEX UQ_Braiding_BraidRef   ON prod.Braiding
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Braiding') AND name=N'IX_Braiding_Status')     DROP INDEX IX_Braiding_Status     ON prod.Braiding
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Braiding') AND name=N'IX_Braiding_CreatedAt')  DROP INDEX IX_Braiding_CreatedAt  ON prod.Braiding
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.Braiding') AND name=N'BraidRef')
    ALTER TABLE prod.Braiding DROP COLUMN BraidRef
ALTER TABLE prod.Braiding ADD BraidRef AS (CAST(N'BR' + RIGHT('00000000' + CAST(BraidingID AS VARCHAR(8)), 8) AS NVARCHAR(10))) PERSISTED
CREATE UNIQUE INDEX UQ_Braiding_BraidRef ON prod.Braiding (BraidRef)
CREATE INDEX IX_Braiding_Status          ON prod.Braiding (Status)    INCLUDE (BraidRef, Material, CreatedAt)
CREATE INDEX IX_Braiding_CreatedAt       ON prod.Braiding (CreatedAt) INCLUDE (BraidRef, Material, Status)

/* prod.Coverline — CL00000001 */
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Coverline') AND name=N'UQ_Coverline_CovRef')   DROP INDEX UQ_Coverline_CovRef   ON prod.Coverline
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Coverline') AND name=N'IX_Coverline_Status')   DROP INDEX IX_Coverline_Status   ON prod.Coverline
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Coverline') AND name=N'IX_Coverline_CreatedAt')DROP INDEX IX_Coverline_CreatedAt ON prod.Coverline
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.Coverline') AND name=N'CovRef')
    ALTER TABLE prod.Coverline DROP COLUMN CovRef
ALTER TABLE prod.Coverline ADD CovRef AS (CAST(N'CL' + RIGHT('00000000' + CAST(CoverlineID AS VARCHAR(8)), 8) AS NVARCHAR(10))) PERSISTED
CREATE UNIQUE INDEX UQ_Coverline_CovRef ON prod.Coverline (CovRef)
CREATE INDEX IX_Coverline_Status         ON prod.Coverline (Status)    INCLUDE (CovRef, Material, CreatedAt)
CREATE INDEX IX_Coverline_CreatedAt      ON prod.Coverline (CreatedAt) INCLUDE (CovRef, Material, Status)

/* prod.TapeWrap — TW00000001 */
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.TapeWrap') AND name=N'UQ_TapeWrap_TWRef')    DROP INDEX UQ_TapeWrap_TWRef    ON prod.TapeWrap
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.TapeWrap') AND name=N'IX_TapeWrap_Status')   DROP INDEX IX_TapeWrap_Status   ON prod.TapeWrap
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.TapeWrap') AND name=N'IX_TapeWrap_CreatedAt')DROP INDEX IX_TapeWrap_CreatedAt ON prod.TapeWrap
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.TapeWrap') AND name=N'TWRef')
    ALTER TABLE prod.TapeWrap DROP COLUMN TWRef
ALTER TABLE prod.TapeWrap ADD TWRef AS (CAST(N'TW' + RIGHT('00000000' + CAST(TapeWrapID AS VARCHAR(8)), 8) AS NVARCHAR(10))) PERSISTED
CREATE UNIQUE INDEX UQ_TapeWrap_TWRef ON prod.TapeWrap (TWRef)
CREATE INDEX IX_TapeWrap_Status       ON prod.TapeWrap (Status)    INCLUDE (TWRef, Material, CreatedAt)
CREATE INDEX IX_TapeWrap_CreatedAt    ON prod.TapeWrap (CreatedAt) INCLUDE (TWRef, Material, Status)

/* prod.Drumming — DR00000001 */
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Drumming') AND name=N'UQ_Drumming_DrumRef')   DROP INDEX UQ_Drumming_DrumRef   ON prod.Drumming
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Drumming') AND name=N'IX_Drumming_SalesOrder')DROP INDEX IX_Drumming_SalesOrder ON prod.Drumming
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Drumming') AND name=N'IX_Drumming_Status')    DROP INDEX IX_Drumming_Status    ON prod.Drumming
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Drumming') AND name=N'IX_Drumming_CreatedAt') DROP INDEX IX_Drumming_CreatedAt ON prod.Drumming
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.Drumming') AND name=N'DrumRef')
    ALTER TABLE prod.Drumming DROP COLUMN DrumRef
ALTER TABLE prod.Drumming ADD DrumRef AS (CAST(N'DR' + RIGHT('00000000' + CAST(DrummingID AS VARCHAR(8)), 8) AS NVARCHAR(10))) PERSISTED
CREATE UNIQUE INDEX UQ_Drumming_DrumRef  ON prod.Drumming (DrumRef)
CREATE INDEX IX_Drumming_SalesOrder      ON prod.Drumming (SalesOrderSAP) INCLUDE (DrumRef, Material, Status)
CREATE INDEX IX_Drumming_Status          ON prod.Drumming (Status)        INCLUDE (DrumRef, Material, CreatedAt)
CREATE INDEX IX_Drumming_CreatedAt       ON prod.Drumming (CreatedAt)     INCLUDE (DrumRef, Material, Status)

/* prod.Ewald — EW00000001 */
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Ewald') AND name=N'UQ_Ewald_EwaldRef')    DROP INDEX UQ_Ewald_EwaldRef    ON prod.Ewald
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Ewald') AND name=N'IX_Ewald_Status')      DROP INDEX IX_Ewald_Status      ON prod.Ewald
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Ewald') AND name=N'IX_Ewald_CreatedAt')   DROP INDEX IX_Ewald_CreatedAt   ON prod.Ewald
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.Ewald') AND name=N'EwaldRef')
    ALTER TABLE prod.Ewald DROP COLUMN EwaldRef
ALTER TABLE prod.Ewald ADD EwaldRef AS (CAST(N'EW' + RIGHT('00000000' + CAST(EwaldID AS VARCHAR(8)), 8) AS NVARCHAR(10))) PERSISTED
CREATE UNIQUE INDEX UQ_Ewald_EwaldRef ON prod.Ewald (EwaldRef)
CREATE INDEX IX_Ewald_Status          ON prod.Ewald (Status)    INCLUDE (EwaldRef, Material, CreatedAt)
CREATE INDEX IX_Ewald_CreatedAt       ON prod.Ewald (CreatedAt) INCLUDE (EwaldRef, Material, Status)

/* prod.Firewall — FW00000001 */
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.Firewall') AND name=N'UQ_Firewall_FWRef')
    DROP INDEX UQ_Firewall_FWRef ON prod.Firewall
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.Firewall') AND name=N'FWRef')
    ALTER TABLE prod.Firewall DROP COLUMN FWRef
ALTER TABLE prod.Firewall ADD FWRef AS (CAST(N'FW' + RIGHT('00000000' + CAST(FirewallID AS VARCHAR(8)), 8) AS NVARCHAR(10))) PERSISTED
CREATE UNIQUE INDEX UQ_Firewall_FWRef ON prod.Firewall (FWRef)

/* prod.HoseAssembly — HA00000001 */
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.HoseAssembly') AND name=N'UQ_HA_HARef')    DROP INDEX UQ_HA_HARef    ON prod.HoseAssembly
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.HoseAssembly') AND name=N'IX_HA_Status')   DROP INDEX IX_HA_Status   ON prod.HoseAssembly
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'prod.HoseAssembly') AND name=N'IX_HA_CreatedAt')DROP INDEX IX_HA_CreatedAt ON prod.HoseAssembly
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'prod.HoseAssembly') AND name=N'HARef')
    ALTER TABLE prod.HoseAssembly DROP COLUMN HARef
ALTER TABLE prod.HoseAssembly ADD HARef AS (CAST(N'HA' + RIGHT('00000000' + CAST(HoseAssemblyID AS VARCHAR(8)), 8) AS NVARCHAR(10))) PERSISTED
CREATE UNIQUE INDEX UQ_HA_HARef    ON prod.HoseAssembly (HARef)
CREATE INDEX IX_HA_Status          ON prod.HoseAssembly (Status)    INCLUDE (HARef, Material, CreatedAt)
CREATE INDEX IX_HA_CreatedAt       ON prod.HoseAssembly (CreatedAt) INCLUDE (HARef, Material, Status)


/* ── 5. Recreate vw_ActiveBatches with EX and no-dash refs ─────────────── */

DECLARE @vw NVARCHAR(MAX)
SET @vw = N'
ALTER VIEW prod.vw_ActiveBatches AS
    SELECT N''MX''  AS ProcessCode, MixingID        AS RecordID, MixRef     AS BatchRef, Material, CAST(TotalWeightKG         AS DECIMAL(12,3)) AS Quantity, N''KG'' AS UOM, Status, ShiftID, NULL AS MachineID, CreatedAt, StartedAt FROM prod.Mixing       WHERE Status IN (1,2) AND IsReversed = 0
    UNION ALL SELECT N''EX'',  ExtrusionID,   ExtRef,   Material, LengthMetres,                          N''M'',  Status, ShiftID, MachineID,              CreatedAt, StartedAt FROM prod.Extrusion    WHERE Status IN (1,2) AND IsReversed=0
    UNION ALL SELECT N''CO'',  ConvolutingID, ConvRef,  Material, LengthMetres,                          N''M'',  Status, ShiftID, MachineID,              CreatedAt, StartedAt FROM prod.Convoluting  WHERE Status IN (1,2) AND IsReversed=0
    UNION ALL SELECT N''BR'',  BraidingID,    BraidRef, Material, LengthMetres,                          N''M'',  Status, ShiftID, MachineID,              CreatedAt, StartedAt FROM prod.Braiding     WHERE Status IN (1,2) AND IsReversed=0
    UNION ALL SELECT N''CL'',  CoverlineID,   CovRef,   Material, LengthMetres,                          N''M'',  Status, ShiftID, MachineID,              CreatedAt, StartedAt FROM prod.Coverline    WHERE Status IN (1,2) AND IsReversed=0
    UNION ALL SELECT N''TW'',  TapeWrapID,    TWRef,    Material, LengthMetres,                          N''M'',  Status, ShiftID, MachineID,              CreatedAt, StartedAt FROM prod.TapeWrap     WHERE Status IN (1,2) AND IsReversed=0
    UNION ALL SELECT N''DR'',  DrummingID,    DrumRef,  Material, LengthMetres,                          N''M'',  Status, ShiftID, NULL      AS MachineID, CreatedAt, StartedAt FROM prod.Drumming     WHERE Status IN (1,2) AND IsReversed=0
    UNION ALL SELECT N''EW'',  EwaldID,       EwaldRef, Material, CAST(TotalPiecesEA AS DECIMAL(12,3)),  N''EA'', Status, ShiftID, MachineID,              CreatedAt, StartedAt FROM prod.Ewald        WHERE Status IN (1,2) AND IsReversed=0
    UNION ALL SELECT N''HA'',  HoseAssemblyID,HARef,    Material, CAST(QuantityEA    AS DECIMAL(12,3)),  N''EA'', Status, ShiftID, MachineID,              CreatedAt, StartedAt FROM prod.HoseAssembly WHERE Status IN (1,2) AND IsReversed=0'
EXEC(@vw)
