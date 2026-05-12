/* ============================================================
   Add DefaultPrinterID to PortalUsers
   Run connected to the kongsberg database.
   ============================================================ */

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE  object_id = OBJECT_ID(N'dbo.PortalUsers')
      AND  name      = N'DefaultPrinterID'
)
    ALTER TABLE dbo.PortalUsers
        ADD DefaultPrinterID NVARCHAR(50) NULL;
