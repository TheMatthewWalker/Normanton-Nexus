/* ============================================================
   MASTER_DATA permission — run against the kongsberg database.
   Compatibility: SQL Server 2005+ (no GO, no MERGE — matches every
   other migration in this project).

   Gates the write actions of the new Engineering > Packaging Data
   tools (Mass Packaging Update, New Packaging Creation, Packaging
   Instruction Detail) — creating real SAP material masters (MM01),
   BOMs (CS01), and packaging-instruction assignments (ZPACK_INSTR_MAINT)
   is high-impact/irreversible, so writes require this permission on
   top of plain Engineering department access (which is enough to view).
   ============================================================ */

IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = N'MASTER_DATA')
  INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category) VALUES
    (N'MASTER_DATA', N'Master Data',
     N'Create/update SAP material masters, BOMs and packaging instructions from Engineering > Packaging Data', N'Engineering');

PRINT 'MASTER_DATA permission verified/added';

/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT PermissionCode FROM dbo.PortalPermissions WHERE PermissionCode = N'MASTER_DATA';
