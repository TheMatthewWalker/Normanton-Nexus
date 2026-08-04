/* ============================================================
   Braiding test-data cleanup - PREVIEW (read-only, no locks held)
   Database: Production   Process: BR (prod.Braiding, PK BraidingID)
   SQL Server 2005 compatible.

   Edit @Cutoff to the first REAL BraidingID (everything below is test
   data), then run. Changes nothing.

   Note: Drumming can consume a Braiding batch as a traceability parent
   (see lib/redrumReversal.js's braid-component reversal) via
   prod.ProductionTrace with MaterialDocumentSAP set. The "as parent"
   count below covers that; if it's non-zero, check whether any of those
   linked Drumming records are real (kept) batches before deleting -
   deleting the trace link doesn't touch the Drumming row itself, but it
   does remove the pointer redrumReversal.js needs to reverse that
   braid-component backflush later.
   ============================================================ */

USE [Production];
SET NOCOUNT ON;

DECLARE @Cutoff INT;
SET @Cutoff = NULL;  -- TODO: set to the first real BraidingID before running

IF @Cutoff IS NULL
BEGIN
    RAISERROR(N'Set @Cutoff to the first real BraidingID before running this preview.', 16, 1);
    RETURN;
END

SELECT 'prod.ProductionTrace (as child)'  AS TableName, COUNT(*) AS RowsAffected FROM prod.ProductionTrace WHERE ChildProcessCode  = 'BR' AND ChildRecordID  < @Cutoff
UNION ALL
SELECT 'prod.ProductionTrace (as parent)', COUNT(*) FROM prod.ProductionTrace WHERE ParentProcessCode = 'BR' AND ParentRecordID < @Cutoff
UNION ALL
SELECT 'prod.BatchOperators',  COUNT(*) FROM prod.BatchOperators WHERE ProcessCode = 'BR' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.ScrapEntries',    COUNT(*) FROM prod.ScrapEntries   WHERE ProcessCode = 'BR' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.SAPPostings',     COUNT(*) FROM prod.SAPPostings    WHERE ProcessCode = 'BR' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.EventLog',        COUNT(*) FROM prod.EventLog       WHERE ProcessCode = 'BR' AND ProcessRecordID < @Cutoff
UNION ALL
SELECT 'prod.Braiding',        COUNT(*) FROM prod.Braiding       WHERE BraidingID < @Cutoff;

SELECT COUNT(*) AS RowsKept FROM prod.Braiding WHERE BraidingID >= @Cutoff;

-- Test braid batches a real (kept) Drumming record still traces back to as a
-- raw-material parent - the Drumming row survives either way, but its trace
-- link (and redrumReversal.js's ability to reverse the braid backflush) won't.
SELECT pt.ParentRecordID AS TestBraidingID, pt.ChildRecordID AS DrummingID, pt.MaterialDocumentSAP
FROM prod.ProductionTrace pt
WHERE pt.ParentProcessCode = 'BR' AND pt.ParentRecordID < @Cutoff
  AND pt.ChildProcessCode = 'DR' AND pt.ChildRecordID >= @Cutoff;

-- Successful SAP postings on test rows that were never reversed - worth eyeballing before delete.
SELECT SAPPostingID, ProcessRecordID, PostingType, MaterialDocumentSAP, IsSuccess, IsReversed, PostedAt
FROM prod.SAPPostings
WHERE ProcessCode = 'BR' AND ProcessRecordID < @Cutoff AND IsSuccess = 1 AND IsReversed = 0
ORDER BY ProcessRecordID;
