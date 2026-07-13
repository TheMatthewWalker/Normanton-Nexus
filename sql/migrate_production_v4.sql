/* ============================================================
   Production DB migration v4
   - Add 'PV' to all ProcessCode CHECK constraints
   - Rewrite OR chains as IN (...) for maintainability
   Run connected to the Production database.
   ============================================================ */

/* ── prod.WorkCentres ────────────────────────────────────────────────────── */
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_WorkCentres_ProcCode'
           AND parent_object_id = OBJECT_ID(N'prod.WorkCentres'))
    ALTER TABLE prod.WorkCentres DROP CONSTRAINT CK_WorkCentres_ProcCode

ALTER TABLE prod.WorkCentres ADD CONSTRAINT CK_WorkCentres_ProcCode
    CHECK (ProcessCode IN (N'MX',N'EXT',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'HA',N'PV'))


/* ── prod.BatchOperators ─────────────────────────────────────────────────── */
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_BatchOp_ProcessCode'
           AND parent_object_id = OBJECT_ID(N'prod.BatchOperators'))
    ALTER TABLE prod.BatchOperators DROP CONSTRAINT CK_BatchOp_ProcessCode

ALTER TABLE prod.BatchOperators ADD CONSTRAINT CK_BatchOp_ProcessCode
    CHECK (ProcessCode IN (N'MX',N'EXT',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'FW',N'HA',N'PV'))


/* ── prod.ProductionTrace ────────────────────────────────────────────────── */
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_Trace_ChildCode'
           AND parent_object_id = OBJECT_ID(N'prod.ProductionTrace'))
    ALTER TABLE prod.ProductionTrace DROP CONSTRAINT CK_Trace_ChildCode

ALTER TABLE prod.ProductionTrace ADD CONSTRAINT CK_Trace_ChildCode
    CHECK (ChildProcessCode IN (N'MX',N'EXT',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'FW',N'HA',N'PV'))


IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_Trace_ParentCode'
           AND parent_object_id = OBJECT_ID(N'prod.ProductionTrace'))
    ALTER TABLE prod.ProductionTrace DROP CONSTRAINT CK_Trace_ParentCode

ALTER TABLE prod.ProductionTrace ADD CONSTRAINT CK_Trace_ParentCode
    CHECK (ParentProcessCode IN (N'MX',N'EXT',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'FW',N'HA',N'PV'))


/* ── prod.ScrapEntries ───────────────────────────────────────────────────── */
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_Scrap_ProcessCode'
           AND parent_object_id = OBJECT_ID(N'prod.ScrapEntries'))
    ALTER TABLE prod.ScrapEntries DROP CONSTRAINT CK_Scrap_ProcessCode

ALTER TABLE prod.ScrapEntries ADD CONSTRAINT CK_Scrap_ProcessCode
    CHECK (ProcessCode IN (N'MX',N'EXT',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'FW',N'HA',N'PV'))


/* ── prod.SAPPostings ────────────────────────────────────────────────────── */
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_SAPPost_ProcessCode'
           AND parent_object_id = OBJECT_ID(N'prod.SAPPostings'))
    ALTER TABLE prod.SAPPostings DROP CONSTRAINT CK_SAPPost_ProcessCode

ALTER TABLE prod.SAPPostings ADD CONSTRAINT CK_SAPPost_ProcessCode
    CHECK (ProcessCode IN (N'MX',N'EXT',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'FW',N'HA',N'PV'))


/* ── prod.EventLog ───────────────────────────────────────────────────────── */
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_EventLog_ProcessCode'
           AND parent_object_id = OBJECT_ID(N'prod.EventLog'))
    ALTER TABLE prod.EventLog DROP CONSTRAINT CK_EventLog_ProcessCode

ALTER TABLE prod.EventLog ADD CONSTRAINT CK_EventLog_ProcessCode
    CHECK (ProcessCode IN (N'MX',N'EXT',N'CO',N'BR',N'CL',N'TW',N'DR',N'EW',N'FW',N'HA',N'PV'))
