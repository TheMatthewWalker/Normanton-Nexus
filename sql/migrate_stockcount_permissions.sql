/* ============================================================
   FIN_STOCK_APPROVE permission — run against the kongsberg database.
   Compatibility: SQL Server 2005+ (no GO, no MERGE — matches every
   other migration in this project).

   Gates the finance-controller approval step of the Stock Count feature
   (Finance > Stock Adjustments tile): approving or rejecting a submitted
   Weekly PTFE / Raw Material / Production count and triggering the
   resulting 711/712/717/718 SAP goods-movement postings. This is a
   distinct trust boundary from warehouse-side LOG_SUPER (which covers
   initiating/running counts, resolving Finished Goods discrepancies, and
   editing the PTFE location map) — LOG_SUPER holders are warehouse
   supervisors, not necessarily anyone trusted to authorize a financial
   write-off, so this is intentionally a separate code rather than reusing
   LOG_SUPER for the approval step too.
   ============================================================ */

IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = N'FIN_STOCK_APPROVE')
  INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category) VALUES
    (N'FIN_STOCK_APPROVE', N'Stock Count Adjustment Approval',
     N'Approve or reject warehouse/production stock count discrepancies and trigger the resulting 711/712 SAP postings', N'Finance');

PRINT 'FIN_STOCK_APPROVE permission verified/added';

/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT PermissionCode FROM dbo.PortalPermissions WHERE PermissionCode = N'FIN_STOCK_APPROVE';
