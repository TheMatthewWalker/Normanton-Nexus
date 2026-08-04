/* ============================================================
   Drumming test-data cleanup - EXECUTE
   Database: Production   Process: DR (prod.Drumming, PK DrummingID)
   Child table: prod.DrummingCoils (real FK, FK_DrummingCoils_DR) - deleted
   first so the FK doesn't block the Drumming delete.
   SQL Server 2005 compatible: no inline DECLARE-init, no CONCAT().

   HOW TO USE
   1. Run preview_drumming.sql first and sanity-check the counts.
   2. Set @Cutoff below (first REAL DrummingID), leave @Commit = 0, and
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
SET @Cutoff = NULL;  -- TODO: set to the first real DrummingID before running

IF @Cutoff IS NULL
BEGIN
    RAISERROR(N'Set @Cutoff to the first real DrummingID before running this script.', 16, 1);
    RETURN;
END

BEGIN TRANSACTION;

DELETE FROM prod.DrummingCoils WHERE DrummingID < @Cutoff;
SET @n = @@ROWCOUNT; PRINT N'prod.DrummingCoils deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.ProductionTrace
WHERE (ChildProcessCode  = 'DR' AND ChildRecordID  < @Cutoff)
   OR (ParentProcessCode = 'DR' AND ParentRecordID < @Cutoff);
SET @n = @@ROWCOUNT; PRINT N'prod.ProductionTrace deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.BatchOperators WHERE ProcessCode = 'DR' AND ProcessRecordID < @Cutoff;
SET @n = @@ROWCOUNT; PRINT N'prod.BatchOperators deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.ScrapEntries WHERE ProcessCode = 'DR' AND ProcessRecordID < @Cutoff;
SET @n = @@ROWCOUNT; PRINT N'prod.ScrapEntries deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.SAPPostings WHERE ProcessCode = 'DR' AND ProcessRecordID < @Cutoff;
SET @n = @@ROWCOUNT; PRINT N'prod.SAPPostings deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.EventLog WHERE ProcessCode = 'DR' AND ProcessRecordID < @Cutoff;
SET @n = @@ROWCOUNT; PRINT N'prod.EventLog deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.Drumming WHERE DrummingID < @Cutoff;
SET @n = @@ROWCOUNT; PRINT N'prod.Drumming deleted: ' + CAST(@n AS NVARCHAR(10));

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
