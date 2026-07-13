/* ============================================================
   Portal Users — rename roles to new hierarchy
   Run connected to the kongsberg database.

   Old → New
   ─────────────────────────────
   viewer     → operator    (level 1)
   editor     → supervisor  (level 2)
   admin      → admin       (level 4, unchanged)
   superadmin → superadmin  (level 5, unchanged)

   New role added: management (level 3)
   ============================================================ */

/* 1. Drop the existing Role CHECK constraint (auto-named by SQL Server) */
DECLARE @con NVARCHAR(256)
SELECT @con = name FROM sys.check_constraints
WHERE parent_object_id = OBJECT_ID(N'dbo.PortalUsers')
  AND CHARINDEX('Role', definition) > 0

IF @con IS NOT NULL
    EXEC('ALTER TABLE dbo.PortalUsers DROP CONSTRAINT ' + @con)

/* 2. Rename the role values */
UPDATE dbo.PortalUsers SET Role = N'operator'   WHERE Role = N'viewer'
UPDATE dbo.PortalUsers SET Role = N'supervisor'  WHERE Role = N'editor'

/* 3. Add new CHECK constraint with the full role set */
ALTER TABLE dbo.PortalUsers ADD CONSTRAINT CK_PortalUsers_Role
    CHECK (Role IN (N'operator', N'supervisor', N'management', N'admin', N'superadmin'))

/* 4. Verify */
SELECT Role, COUNT(*) AS UserCount
FROM dbo.PortalUsers
GROUP BY Role
ORDER BY Role
