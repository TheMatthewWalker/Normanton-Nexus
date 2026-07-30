/* ============================================================
   VENDOR_CONSIGNMENT permission — run against the kongsberg database.
   Compatibility: SQL Server 2005+ (no GO, no MERGE — matches every
   other migration in this project).

   Gates the "elevated" step of the Vendor Consignment Tracker (Logistics
   > Material Planning): confirming a declaration and recording the SAP
   settlement document number after MRKO has been run. Viewing the
   tracker, the balance dashboard, and building a draft declaration only
   need plain Logistics department access (LOG_MRP is already used for
   ordinary vendor/MRP writes) — this permission is specifically for the
   step that commits a declaration as having been settled against a real
   supplier invoice, matching the "elevated user permission to call
   MRKO" requirement.
   ============================================================ */

IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = N'VENDOR_CONSIGNMENT')
  INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category) VALUES
    (N'VENDOR_CONSIGNMENT', N'Vendor Consignment Settlement',
     N'Confirm vendor consignment declarations and record MRKO settlement document numbers', N'Logistics');

PRINT 'VENDOR_CONSIGNMENT permission verified/added';

/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT PermissionCode FROM dbo.PortalPermissions WHERE PermissionCode = N'VENDOR_CONSIGNMENT';
