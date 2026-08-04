/* ============================================================
   Convoluting test-data cleanup - PREVIEW (read-only, no locks held)
   Database: Production   Process: CO (prod.Convoluting, PK ConvolutingID)
   SQL Server 2005 compatible.

   Edit @Cutoff to the first REAL ConvolutingID (everything below is test
   data), then run. Changes nothing.
   ============================================================ */

USE [Production];
SET NOCOUNT ON;

DECLARE @Cutoff INT;
SET @Cutoff = NULL;  -- TODO: set to the first real ConvolutingID before running

IF @Cutoff IS NULL
BEGIN
    RAISERROR(N'Set @Cutoff to the first real ConvolutingID before running this preview.', 16, 1);
    RETURN;
END

SELECT 'prod.ProductionTrace (as child)'  AS TableName, COUNT(*) AS RowsAffected FROM prod.ProductionTrace WHERE ChildProcessCode  = 'CO' AND ChildRecordID  < @Cutoff
UNION ALL
SELECT 'prod.ProductionTrace (as parent)', COUNT(*) FROM prod.ProductionTrace WHERE ParentProcessCode = 'CO' AND ParentRecordID < @Cutoff
UNION ALL
SELECT 'prod.BatchOperators',  COUNT(*) FROM prod.BatchOperators WHERE ProcessCode = 'CO' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.ScrapEntries',    COUNT(*) FROM prod.ScrapEntries   WHERE ProcessCode = 'CO' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.SAPPostings',     COUNT(*) FROM prod.SAPPostings    WHERE ProcessCode = 'CO' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.EventLog',        COUNT(*) FROM prod.EventLog       WHERE ProcessCode = 'CO' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.Convoluting',     COUNT(*) FROM prod.Convoluting    WHERE ConvolutingID < @Cutoff;

SELECT COUNT(*) AS RowsKept FROM prod.Convoluting WHERE ConvolutingID >= @Cutoff;

-- Successful SAP postings on test rows that were never reversed - worth eyeballing before delete.
SELECT SAPPostingID, ProcessRecordID, PostingType, MaterialDocumentSAP, IsSuccess, IsReversed, PostedAt
FROM prod.SAPPostings
WHERE ProcessCode = 'CO' AND ProcessRecordID < @Cutoff AND IsSuccess = 1 AND IsReversed = 0
ORDER BY ProcessRecordID;
