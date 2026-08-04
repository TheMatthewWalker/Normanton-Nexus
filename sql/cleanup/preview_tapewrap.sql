/* ============================================================
   TapeWrap test-data cleanup - PREVIEW (read-only, no locks held)
   Database: Production   Process: TW (prod.TapeWrap, PK TapeWrapID)
   SQL Server 2005 compatible.

   Edit @Cutoff to the first REAL TapeWrapID (everything below is test
   data), then run. Changes nothing.
   ============================================================ */

USE [Production];
SET NOCOUNT ON;

DECLARE @Cutoff INT;
SET @Cutoff = NULL;  -- TODO: set to the first real TapeWrapID before running

IF @Cutoff IS NULL
BEGIN
    RAISERROR(N'Set @Cutoff to the first real TapeWrapID before running this preview.', 16, 1);
    RETURN;
END

SELECT 'prod.ProductionTrace (as child)'  AS TableName, COUNT(*) AS RowsAffected FROM prod.ProductionTrace WHERE ChildProcessCode  = 'TW' AND ChildRecordID  < @Cutoff
UNION ALL
SELECT 'prod.ProductionTrace (as parent)', COUNT(*) FROM prod.ProductionTrace WHERE ParentProcessCode = 'TW' AND ParentRecordID < @Cutoff
UNION ALL
SELECT 'prod.BatchOperators',  COUNT(*) FROM prod.BatchOperators WHERE ProcessCode = 'TW' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.ScrapEntries',    COUNT(*) FROM prod.ScrapEntries   WHERE ProcessCode = 'TW' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.SAPPostings',     COUNT(*) FROM prod.SAPPostings    WHERE ProcessCode = 'TW' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.EventLog',        COUNT(*) FROM prod.EventLog       WHERE ProcessCode = 'TW' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.TapeWrap',        COUNT(*) FROM prod.TapeWrap       WHERE TapeWrapID < @Cutoff;

SELECT COUNT(*) AS RowsKept FROM prod.TapeWrap WHERE TapeWrapID >= @Cutoff;

-- Successful SAP postings on test rows that were never reversed - worth eyeballing before delete.
SELECT SAPPostingID, ProcessRecordID, PostingType, MaterialDocumentSAP, IsSuccess, IsReversed, PostedAt
FROM prod.SAPPostings
WHERE ProcessCode = 'TW' AND ProcessRecordID < @Cutoff AND IsSuccess = 1 AND IsReversed = 0
ORDER BY ProcessRecordID;
