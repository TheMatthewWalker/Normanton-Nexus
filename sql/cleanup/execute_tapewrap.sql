/* ============================================================
   TapeWrap test-data cleanup - EXECUTE
   Database: Production   Process: TW (prod.TapeWrap, PK TapeWrapID)
   SQL Server 2005 compatible: no inline DECLARE-init, no CONCAT().

   HOW TO USE
   1. Run preview_tapewrap.sql first and sanity-check the counts.
   2. Set @Cutoff below (first REAL TapeWrapID), leave @Commit = 0, and
      run. It performs the real deletes inside a transaction, prints how
      many rows were removed from each table, then ROLLS BACK - nothing
      is persisted. Confirm the printed counts match the preview.
   3. Only after that looks right, change @Commit to 1 and run again to
      actually commit the deletes.
   ============================================================ */

USE [Production];
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Commit BIT;
DECLARE @Cutoff INT;
DECLARE @n INT;

SET @Commit = 0;
SET @Cutoff = NULL;  -- TODO: set to the first real TapeWrapID before running

IF @Cutoff IS NULL
BEGIN
    RAISERROR(N'Set @Cutoff to the first real TapeWrapID before running this script.', 16, 1);
    RETURN;
END

BEGIN TRANSACTION;

DELETE FROM prod.ProductionTrace
WHERE (ChildProcessCode  = 'TW' AND ChildRecordID  < @Cutoff)
   OR (ParentProcessCode = 'TW' AND ParentRecordID < @Cutoff);
SET @n = @@ROWCOUNT; PRINT N'prod.ProductionTrace deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.BatchOperators WHERE ProcessCode = 'TW' AND ProcessRecordID < @Cutoff;
SET @n = @@ROWCOUNT; PRINT N'prod.BatchOperators deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.ScrapEntries WHERE ProcessCode = 'TW' AND ProcessRecordID < @Cutoff;
SET @n = @@ROWCOUNT; PRINT N'prod.ScrapEntries deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.SAPPostings WHERE ProcessCode = 'TW' AND ProcessRecordID < @Cutoff;
SET @n = @@ROWCOUNT; PRINT N'prod.SAPPostings deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.EventLog WHERE ProcessCode = 'TW' AND ProcessRecordID < @Cutoff;
SET @n = @@ROWCOUNT; PRINT N'prod.EventLog deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.TapeWrap WHERE TapeWrapID < @Cutoff;
SET @n = @@ROWCOUNT; PRINT N'prod.TapeWrap deleted: ' + CAST(@n AS NVARCHAR(10));

IF @Commit = 1
BEGIN
    COMMIT TRANSACTION;
    PRINT N'*** COMMITTED - changes are permanent. ***';
END
ELSE
BEGIN
    ROLLBACK TRANSACTION;
    PRINT N'*** DRY RUN ONLY - rolled back, nothing changed. Set @Commit = 1 to actually delete. ***';
END
