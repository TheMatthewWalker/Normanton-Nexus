/* ============================================================
   LOG_CUSTOMS_REPORT permission — run against the kongsberg database.
   Compatibility: SQL Server 2005+ (no GO, no MERGE — matches every
   other migration in this project).

   Gates the French VAT / DDP Customs Report tile (Logistics): uploads a
   Shipments-style list (delivery number, shipment ref, collection date,
   weight), enriches it via SAP, and produces the monthly CUSTOMS-format
   .xlsx sent to the French VAT support company. A dedicated permission
   (rather than reusing an existing broad Logistics code) since this
   report carries customer VAT numbers and sales values — access should
   be deliberately granted, not implied by general logistics admin
   access.
   ============================================================ */

IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = N'LOG_CUSTOMS_REPORT')
  INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category) VALUES
    (N'LOG_CUSTOMS_REPORT', N'French VAT Customs Report',
     N'Generate the monthly DDP France import-VAT report (SAP-enriched Shipments upload -> CUSTOMS-format .xlsx)', N'Logistics');

PRINT 'LOG_CUSTOMS_REPORT permission verified/added';

/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT PermissionCode FROM dbo.PortalPermissions WHERE PermissionCode = N'LOG_CUSTOMS_REPORT';
