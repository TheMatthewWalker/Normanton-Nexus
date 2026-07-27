/* ============================================================
   LOG_REPORTS permission — run against the kongsberg database.
   Compatibility: SQL Server 2005+ (no GO, no MERGE — matches every
   other migration in this project).

   Splits the Logistics page's old single "Admin" tile section into
   two: Reports (Freight Spend, Haulier On-Time Performance, Stock
   Value Overview, Stock Value by Price — all read-only dashboards)
   and Admin (everything that changes data — Update Forwarders,
   Material Group Mapping, Cost Centres, GL Accounts, Unprocessed
   Costs, etc., unchanged).

   LOG_REPORTS lets someone view the Reports section without holding
   LOG_ADMIN, LOG_MRP or any other data-changing permission — e.g. a
   manager who wants visibility into freight spend and on-time
   performance but has no business editing forwarders or posting
   costs to SAP.

   The Reports section (and its four underlying API routes) is gated
   on ANY of LOG_ADMIN, LOG_MRP or LOG_REPORTS — LOG_ADMIN/LOG_MRP
   holders keep exactly the access they already had (Freight Spend/
   Haulier OTIF were LOG_ADMIN-gated, Stock Value Overview/by Price
   were LOG_MRP-gated, both under different section names), and
   LOG_REPORTS is purely an additional, narrower way in.
   ============================================================ */

IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = N'LOG_REPORTS')
  INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category) VALUES
    (N'LOG_REPORTS', N'Logistics Reports',
     N'View Logistics reports (Freight Spend, Haulier On-Time Performance, Stock Value Overview, Stock Value by Price) without any data-editing access', N'Logistics');

PRINT 'LOG_REPORTS permission verified/added';

/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT PermissionCode FROM dbo.PortalPermissions WHERE PermissionCode = N'LOG_REPORTS';
