/* ============================================================
   QUAL_CONCESSION permission — run against the kongsberg database.
   Compatibility: SQL Server 2005+ (no GO, no MERGE — matches every
   other migration in this project).

   Gates approval/rejection of a Traceability Concession — a Production
   supervisor's request to proceed with a job whose traceability doesn't
   match its SAP BOM (routes/productionnexus.js's
   POST /concessions/:id/approve|reject). Raising a concession itself needs
   no special permission (any user blocked by the mismatch can raise one),
   but only a Quality reviewer holding this permission can approve or
   reject it. Distinct from QUAL_BLOCKING (SAP stock block/unblock) — this
   is a separate action within the Quality department.
   ============================================================ */

IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = N'QUAL_CONCESSION')
  INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category) VALUES
    (N'QUAL_CONCESSION', N'Approve Traceability Concessions',
     N'Approve or reject a Production traceability concession (BOM mismatch override)', N'Quality');

PRINT 'QUAL_CONCESSION permission verified/added';

/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT PermissionCode FROM dbo.PortalPermissions WHERE PermissionCode = N'QUAL_CONCESSION';
