/* ============================================================
   Ewald test-data cleanup - PREVIEW (read-only, no locks held)
   Database: Production   Process: EW (prod.Ewald, PK EwaldID)
   SQL Server 2005 compatible.

   Ewald has two dependents:
     - prod.EwaldBoxes (real FK, FK_EwaldBoxes_Ewald) - a true child table.
     - prod.Firewall (real FK, FK_Firewall_Ewald) - a SEPARATE process (its
       own FirewallID, its own FW-coded rows in the generic tables) that
       references Ewald. Any Firewall row inspecting a test Ewald batch
       must be treated as test data too, REGARDLESS of that Firewall row's
       own FirewallID, or the FK will block the Ewald delete in
       execute_ewald.sql. If Firewall has its own independent go-live
       schedule, use preview_firewall.sql / execute_firewall.sql for the
       rest of Firewall's test data (FirewallID range not tied to a test
       Ewald batch).

   Edit @Cutoff to the first REAL EwaldID (everything below is test data),
   then run. Changes nothing.
   ============================================================ */

USE [Production];
SET NOCOUNT ON;

DECLARE @Cutoff INT;
SET @Cutoff = NULL;  -- TODO: set to the first real EwaldID before running

IF @Cutoff IS NULL
BEGIN
    RAISERROR(N'Set @Cutoff to the first real EwaldID before running this preview.', 16, 1);
    RETURN;
END

SELECT 'prod.EwaldBoxes'   AS TableName, COUNT(*) AS RowsAffected FROM prod.EwaldBoxes WHERE EwaldID < @Cutoff
UNION ALL
SELECT 'prod.Firewall (dependents of test Ewald batches)', COUNT(*) FROM prod.Firewall WHERE EwaldID < @Cutoff
UNION ALL
SELECT 'prod.ProductionTrace (FW dependents, as child)',   COUNT(*)
    FROM prod.ProductionTrace pt
    JOIN prod.Firewall fw ON fw.FirewallID = pt.ChildRecordID AND pt.ChildProcessCode = 'FW'
    WHERE fw.EwaldID < @Cutoff
UNION ALL
SELECT 'prod.ProductionTrace (FW dependents, as parent)',  COUNT(*)
    FROM prod.ProductionTrace pt
    JOIN prod.Firewall fw ON fw.FirewallID = pt.ParentRecordID AND pt.ParentProcessCode = 'FW'
    WHERE fw.EwaldID < @Cutoff
UNION ALL
SELECT 'prod.BatchOperators (FW dependents)', COUNT(*) FROM prod.BatchOperators bo JOIN prod.Firewall fw ON fw.FirewallID = bo.ProcessRecordID AND bo.ProcessCode = 'FW' WHERE fw.EwaldID < @Cutoff
UNION ALL
SELECT 'prod.ScrapEntries (FW dependents)',   COUNT(*) FROM prod.ScrapEntries se JOIN prod.Firewall fw ON fw.FirewallID = se.ProcessRecordID AND se.ProcessCode = 'FW' WHERE fw.EwaldID < @Cutoff
UNION ALL
SELECT 'prod.SAPPostings (FW dependents)',    COUNT(*) FROM prod.SAPPostings sp JOIN prod.Firewall fw ON fw.FirewallID = sp.ProcessRecordID AND sp.ProcessCode = 'FW' WHERE fw.EwaldID < @Cutoff
UNION ALL
SELECT 'prod.EventLog (FW dependents)',       COUNT(*) FROM prod.EventLog el JOIN prod.Firewall fw ON fw.FirewallID = el.ProcessRecordID AND el.ProcessCode = 'FW' WHERE fw.EwaldID < @Cutoff
UNION ALL
SELECT 'prod.ProductionTrace (EW, as child)',  COUNT(*) FROM prod.ProductionTrace WHERE ChildProcessCode  = 'EW' AND ChildRecordID  < @Cutoff
UNION ALL
SELECT 'prod.ProductionTrace (EW, as parent)', COUNT(*) FROM prod.ProductionTrace WHERE ParentProcessCode = 'EW' AND ParentRecordID < @Cutoff
UNION ALL
SELECT 'prod.BatchOperators (EW)', COUNT(*) FROM prod.BatchOperators WHERE ProcessCode = 'EW' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.ScrapEntries (EW)',   COUNT(*) FROM prod.ScrapEntries   WHERE ProcessCode = 'EW' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.SAPPostings (EW)',    COUNT(*) FROM prod.SAPPostings    WHERE ProcessCode = 'EW' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.EventLog (EW)',       COUNT(*) FROM prod.EventLog       WHERE ProcessCode = 'EW' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.Ewald',               COUNT(*) FROM prod.Ewald          WHERE EwaldID < @Cutoff;

SELECT COUNT(*) AS RowsKept FROM prod.Ewald WHERE EwaldID >= @Cutoff;

-- Real (kept) Firewall inspections that would be swept up as a dependent of
-- a test Ewald batch - unusual to have, worth a second look.
SELECT fw.FirewallID, fw.EwaldID
FROM prod.Firewall fw
WHERE fw.EwaldID < @Cutoff AND fw.FirewallID >= @Cutoff;

-- Successful SAP postings (Ewald or its Firewall dependents) that were never
-- reversed - worth eyeballing before delete.
SELECT 'EW' AS ProcessCode, SAPPostingID, ProcessRecordID, PostingType, MaterialDocumentSAP, IsSuccess, IsReversed, PostedAt
FROM prod.SAPPostings
WHERE ProcessCode = 'EW' AND ProcessRecordID < @Cutoff AND IsSuccess = 1 AND IsReversed = 0
UNION ALL
SELECT 'FW', sp.SAPPostingID, sp.ProcessRecordID, sp.PostingType, sp.MaterialDocumentSAP, sp.IsSuccess, sp.IsReversed, sp.PostedAt
FROM prod.SAPPostings sp
JOIN prod.Firewall fw ON fw.FirewallID = sp.ProcessRecordID AND sp.ProcessCode = 'FW'
WHERE fw.EwaldID < @Cutoff AND sp.IsSuccess = 1 AND sp.IsReversed = 0
ORDER BY ProcessRecordID;
