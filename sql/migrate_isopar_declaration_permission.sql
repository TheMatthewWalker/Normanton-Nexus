/* ============================================================
   ISOPAR_DECL permission — run against the kongsberg database.
   Compatibility: SQL Server 2005+ (no GO, no MERGE — matches every
   other migration in this project).

   Gates the HMRC Tied Oil declaration section of the "Isopar Tied Oil"
   tile (Logistics > Material Planning) — viewing outstanding/historical
   declarations for Material 10010 and confirming a period's submission.
   Distinct from LOG_MRP, which gates the daily meter-reading log and
   planning-rate settings on the same tile: an operator can log a reading
   without being the person responsible for the quarterly HMRC filing.
   Also the target of the "declaration due" notification (routes/
   performance.js's checkIsoparDeclarationDue, run daily via server.js's
   cron).
   ============================================================ */

IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = N'ISOPAR_DECL')
  INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category) VALUES
    (N'ISOPAR_DECL', N'Isopar HMRC Tied Oil Declarations',
     N'View and confirm Isopar (Material 10010) HMRC Tied Oil declarations each 3-month period', N'Logistics');

PRINT 'ISOPAR_DECL permission verified/added';

/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT PermissionCode FROM dbo.PortalPermissions WHERE PermissionCode = N'ISOPAR_DECL';
