/* ============================================================
   Firewall test-data cleanup - PREVIEW (read-only, no locks held)
   Database: Production   Process: FW (prod.Firewall, PK FirewallID)
   SQL Server 2005 compatible.

   Standalone cleanup by Firewall's OWN ID range - use this when Firewall
   test data needs clearing independently of Ewald (e.g. Firewall wasn't
   part of the same go-live wave). If you're clearing EWALD test data,
   use preview_ewald.sql / execute_ewald.sql instead - Firewall rows that
   depend on a test Ewald batch (FK_Firewall_Ewald) are handled there
   regardless of their own FirewallID, since the FK would otherwise block
   the Ewald delete.

   Edit @Cutoff to the first REAL FirewallID (everything below is test
   data), then run. Changes nothing.
   ============================================================ */

USE [Production];
SET NOCOUNT ON;

DECLARE @Cutoff INT;
SET @Cutoff = NULL;  -- TODO: set to the first real FirewallID before running

IF @Cutoff IS NULL
BEGIN
    RAISERROR(N'Set @Cutoff to the first real FirewallID before running this preview.', 16, 1);
    RETURN;
END

SELECT 'prod.ProductionTrace (as child)'  AS TableName, COUNT(*) AS RowsAffected FROM prod.ProductionTrace WHERE ChildProcessCode  = 'FW' AND ChildRecordID  < @Cutoff
UNION ALL
SELECT 'prod.ProductionTrace (as parent)', COUNT(*) FROM prod.ProductionTrace WHERE ParentProcessCode = 'FW' AND ParentRecordID < @Cutoff
UNION ALL
SELECT 'prod.BatchOperators',  COUNT(*) FROM prod.BatchOperators WHERE ProcessCode = 'FW' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.ScrapEntries',    COUNT(*) FROM prod.ScrapEntries   WHERE ProcessCode = 'FW' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.SAPPostings',     COUNT(*) FROM prod.SAPPostings    WHERE ProcessCode = 'FW' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.EventLog',        COUNT(*) FROM prod.EventLog       WHERE ProcessCode = 'FW' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.Firewall',        COUNT(*) FROM prod.Firewall       WHERE FirewallID < @Cutoff;

SELECT COUNT(*) AS RowsKept FROM prod.Firewall WHERE FirewallID >= @Cutoff;

-- Sanity check: real (kept) Ewald batches whose Firewall inspection would be
-- deleted by this script - inspecting a real batch is unusual test data to
-- have, worth a second look.
SELECT fw.FirewallID, fw.EwaldID
FROM prod.Firewall fw
WHERE fw.FirewallID < @Cutoff AND fw.EwaldID >= @Cutoff;

-- Successful SAP postings on test rows that were never reversed - worth eyeballing before delete.
SELECT SAPPostingID, ProcessRecordID, PostingType, MaterialDocumentSAP, IsSuccess, IsReversed, PostedAt
FROM prod.SAPPostings
WHERE ProcessCode = 'FW' AND ProcessRecordID < @Cutoff AND IsSuccess = 1 AND IsReversed = 0
ORDER BY ProcessRecordID;
