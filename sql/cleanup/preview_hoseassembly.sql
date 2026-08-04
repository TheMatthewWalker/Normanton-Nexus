/* ============================================================
   HoseAssembly test-data cleanup - PREVIEW (read-only, no locks held)
   Database: Production   Process: HA (prod.HoseAssembly, PK HoseAssemblyID)
   SQL Server 2005 compatible.

   Note: prod.HoseAssemblyQARouting is a Material-keyed config table (which
   materials require QA), not per-batch data - deliberately not touched here.

   Edit @Cutoff to the first REAL HoseAssemblyID (everything below is test
   data), then run. Changes nothing.
   ============================================================ */

USE [Production];
SET NOCOUNT ON;

DECLARE @Cutoff INT;
SET @Cutoff = NULL;  -- TODO: set to the first real HoseAssemblyID before running

IF @Cutoff IS NULL
BEGIN
    RAISERROR(N'Set @Cutoff to the first real HoseAssemblyID before running this preview.', 16, 1);
    RETURN;
END

SELECT 'prod.ProductionTrace (as child)'  AS TableName, COUNT(*) AS RowsAffected FROM prod.ProductionTrace WHERE ChildProcessCode  = 'HA' AND ChildRecordID  < @Cutoff
UNION ALL
SELECT 'prod.ProductionTrace (as parent)', COUNT(*) FROM prod.ProductionTrace WHERE ParentProcessCode = 'HA' AND ParentRecordID < @Cutoff
UNION ALL
SELECT 'prod.BatchOperators',  COUNT(*) FROM prod.BatchOperators WHERE ProcessCode = 'HA' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.ScrapEntries',    COUNT(*) FROM prod.ScrapEntries   WHERE ProcessCode = 'HA' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.SAPPostings',     COUNT(*) FROM prod.SAPPostings    WHERE ProcessCode = 'HA' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.EventLog',        COUNT(*) FROM prod.EventLog       WHERE ProcessCode = 'HA' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.HoseAssembly',    COUNT(*) FROM prod.HoseAssembly   WHERE HoseAssemblyID < @Cutoff;

SELECT COUNT(*) AS RowsKept FROM prod.HoseAssembly WHERE HoseAssemblyID >= @Cutoff;

-- Successful SAP postings on test rows that were never reversed - worth eyeballing before delete.
SELECT SAPPostingID, ProcessRecordID, PostingType, MaterialDocumentSAP, IsSuccess, IsReversed, PostedAt
FROM prod.SAPPostings
WHERE ProcessCode = 'HA' AND ProcessRecordID < @Cutoff AND IsSuccess = 1 AND IsReversed = 0
ORDER BY ProcessRecordID;
