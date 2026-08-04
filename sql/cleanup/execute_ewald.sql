/* ============================================================
   Ewald test-data cleanup - EXECUTE
   Database: Production   Process: EW (prod.Ewald, PK EwaldID)
   SQL Server 2005 compatible: no inline DECLARE-init, no CONCAT().

   Ewald has two dependents, both handled here:
     - prod.EwaldBoxes (real FK, FK_EwaldBoxes_Ewald) - deleted by EwaldID.
     - prod.Firewall (real FK, FK_Firewall_Ewald) - a separate process.
       Any Firewall row inspecting a test Ewald batch is captured into
       @AffectedFW below and removed - along with ITS OWN FW-coded rows in
       the generic tables - regardless of that Firewall row's own
       FirewallID, before the Ewald delete runs. This does NOT touch
       Firewall test data unrelated to a test Ewald batch - for that, use
       execute_firewall.sql separately with Firewall's own cutoff.

   HOW TO USE
   1. Run preview_ewald.sql first and sanity-check the counts, including
      the "real Firewall inspection swept up as a dependent" check.
   2. Set @Cutoff below (first REAL EwaldID), leave @Commit = 0, and run.
      It performs the real deletes inside a transaction, prints how many
      rows were removed from each table, then ROLLS BACK - nothing is
      persisted. Confirm the printed counts match the preview.
   3. Only after that looks right, change @Commit to 1 and run again to
      actually commit the deletes.
   ============================================================ */

USE [Production];
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Commit BIT;
DECLARE @Cutoff INT;
DECLARE @n INT;
DECLARE @AffectedFW TABLE (FirewallID INT PRIMARY KEY);

SET @Commit = 0;
SET @Cutoff = NULL;  -- TODO: set to the first real EwaldID before running

IF @Cutoff IS NULL
BEGIN
    RAISERROR(N'Set @Cutoff to the first real EwaldID before running this script.', 16, 1);
    RETURN;
END

BEGIN TRANSACTION;

INSERT INTO @AffectedFW (FirewallID)
SELECT FirewallID FROM prod.Firewall WHERE EwaldID < @Cutoff;

DELETE FROM prod.ProductionTrace
WHERE (ChildProcessCode  = 'FW' AND ChildRecordID  IN (SELECT FirewallID FROM @AffectedFW))
   OR (ParentProcessCode = 'FW' AND ParentRecordID IN (SELECT FirewallID FROM @AffectedFW));
SET @n = @@ROWCOUNT; PRINT N'prod.ProductionTrace (FW dependents) deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.BatchOperators WHERE ProcessCode = 'FW' AND ProcessRecordID IN (SELECT FirewallID FROM @AffectedFW);
SET @n = @@ROWCOUNT; PRINT N'prod.BatchOperators (FW dependents) deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.ScrapEntries WHERE ProcessCode = 'FW' AND ProcessRecordID IN (SELECT FirewallID FROM @AffectedFW);
SET @n = @@ROWCOUNT; PRINT N'prod.ScrapEntries (FW dependents) deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.SAPPostings WHERE ProcessCode = 'FW' AND ProcessRecordID IN (SELECT FirewallID FROM @AffectedFW);
SET @n = @@ROWCOUNT; PRINT N'prod.SAPPostings (FW dependents) deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.EventLog WHERE ProcessCode = 'FW' AND ProcessRecordID IN (SELECT FirewallID FROM @AffectedFW);
SET @n = @@ROWCOUNT; PRINT N'prod.EventLog (FW dependents) deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.Firewall WHERE FirewallID IN (SELECT FirewallID FROM @AffectedFW);
SET @n = @@ROWCOUNT; PRINT N'prod.Firewall (dependents of test Ewald batches) deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.EwaldBoxes WHERE EwaldID < @Cutoff;
SET @n = @@ROWCOUNT; PRINT N'prod.EwaldBoxes deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.ProductionTrace
WHERE (ChildProcessCode  = 'EW' AND ChildRecordID  < @Cutoff)
   OR (ParentProcessCode = 'EW' AND ParentRecordID < @Cutoff);
SET @n = @@ROWCOUNT; PRINT N'prod.ProductionTrace (EW) deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.BatchOperators WHERE ProcessCode = 'EW' AND ProcessRecordID < @Cutoff;
SET @n = @@ROWCOUNT; PRINT N'prod.BatchOperators (EW) deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.ScrapEntries WHERE ProcessCode = 'EW' AND ProcessRecordID < @Cutoff;
SET @n = @@ROWCOUNT; PRINT N'prod.ScrapEntries (EW) deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.SAPPostings WHERE ProcessCode = 'EW' AND ProcessRecordID < @Cutoff;
SET @n = @@ROWCOUNT; PRINT N'prod.SAPPostings (EW) deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.EventLog WHERE ProcessCode = 'EW' AND ProcessRecordID < @Cutoff;
SET @n = @@ROWCOUNT; PRINT N'prod.EventLog (EW) deleted: ' + CAST(@n AS NVARCHAR(10));

DELETE FROM prod.Ewald WHERE EwaldID < @Cutoff;
SET @n = @@ROWCOUNT; PRINT N'prod.Ewald deleted: ' + CAST(@n AS NVARCHAR(10));

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
