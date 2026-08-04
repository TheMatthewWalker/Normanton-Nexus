/* ============================================================
   Drumming test-data cleanup - PREVIEW (read-only, no locks held)
   Database: Production   Process: DR (prod.Drumming, PK DrummingID)
   Child table: prod.DrummingCoils (real FK, FK_DrummingCoils_DR)
   SQL Server 2005 compatible.

   Edit @Cutoff to the first REAL DrummingID (everything below is test
   data), then run. Changes nothing.
   ============================================================ */

USE [Production];
SET NOCOUNT ON;

DECLARE @Cutoff INT;
SET @Cutoff = NULL;  -- TODO: set to the first real DrummingID before running

IF @Cutoff IS NULL
BEGIN
    RAISERROR(N'Set @Cutoff to the first real DrummingID before running this preview.', 16, 1);
    RETURN;
END

SELECT 'prod.DrummingCoils'    AS TableName, COUNT(*) AS RowsAffected FROM prod.DrummingCoils WHERE DrummingID < @Cutoff
UNION ALL
SELECT 'prod.ProductionTrace (as child)',    COUNT(*) FROM prod.ProductionTrace WHERE ChildProcessCode  = 'DR' AND ChildRecordID  < @Cutoff
UNION ALL
SELECT 'prod.ProductionTrace (as parent)',   COUNT(*) FROM prod.ProductionTrace WHERE ParentProcessCode = 'DR' AND ParentRecordID < @Cutoff
UNION ALL
SELECT 'prod.BatchOperators',  COUNT(*) FROM prod.BatchOperators WHERE ProcessCode = 'DR' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.ScrapEntries',    COUNT(*) FROM prod.ScrapEntries   WHERE ProcessCode = 'DR' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.SAPPostings',     COUNT(*) FROM prod.SAPPostings    WHERE ProcessCode = 'DR' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.EventLog',        COUNT(*) FROM prod.EventLog       WHERE ProcessCode = 'DR' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.Drumming',        COUNT(*) FROM prod.Drumming       WHERE DrummingID < @Cutoff;

SELECT COUNT(*) AS RowsKept FROM prod.Drumming WHERE DrummingID >= @Cutoff;

-- Successful SAP postings (drum backflushes) on test rows that were never
-- reversed - worth eyeballing before delete; see lib/redrumReversal.js for
-- what reversing one of these actually involves.
SELECT SAPPostingID, ProcessRecordID, PostingType, MaterialDocumentSAP, IsSuccess, IsReversed, PostedAt
FROM prod.SAPPostings
WHERE ProcessCode = 'DR' AND ProcessRecordID < @Cutoff AND IsSuccess = 1 AND IsReversed = 0
ORDER BY ProcessRecordID;
