/* ============================================================
   Permissions system — run against the kongsberg database.

   1. Simplify roles → operator / admin / superadmin
   2. Create PortalPermissions definition table
   3. Create PortalUserPermissions junction table
   4. Seed initial permission codes
   ============================================================ */

/* ── 1. Drop existing Role CHECK constraint ─────────────────────────────── */
DECLARE @con NVARCHAR(256)
SELECT @con = name FROM sys.check_constraints
WHERE parent_object_id = OBJECT_ID(N'dbo.PortalUsers')
  AND CHARINDEX('Role', definition) > 0

IF @con IS NOT NULL
    EXEC('ALTER TABLE dbo.PortalUsers DROP CONSTRAINT ' + @con)

/* Collapse supervisor / management → operator */
UPDATE dbo.PortalUsers SET Role = N'operator'
WHERE Role IN (N'supervisor', N'management', N'viewer', N'editor')

/* New constraint: 3 roles only */
ALTER TABLE dbo.PortalUsers ADD CONSTRAINT CK_PortalUsers_Role
    CHECK (Role IN (N'operator', N'admin', N'superadmin'))


/* ── 2. Permission definitions ───────────────────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PortalPermissions') AND type = 'U')
BEGIN
    CREATE TABLE dbo.PortalPermissions (
        PermissionCode NVARCHAR(50)  NOT NULL,
        PermissionName NVARCHAR(100) NOT NULL,
        Description    NVARCHAR(500) NULL,
        Category       NVARCHAR(50)  NOT NULL DEFAULT N'General',
        CreatedAt      DATETIME      NOT NULL DEFAULT GETDATE(),
        CONSTRAINT PK_PortalPermissions PRIMARY KEY (PermissionCode)
    )

    /* Seed: Production */
INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category) VALUES
    (N'PROD_SUPERVISOR', N'Production Supervisor',
     N'Approve scrap, retry failed backflush, SAP reversals, reports', N'Production');
INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category) VALUES
    (N'PROD_ENTRY',      N'Production Entry',
     N'Enter mixing, drumming and all other work centre batches',       N'Production');
INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category) VALUES
    (N'PROD_DATA',       N'Production Data',
     N'View production data, traceability and batch history',           N'Production');

    /* Seed: Logistics */
INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category) VALUES
    (N'LOG_PLANNING',    N'Logistics Planning',
     N'Create and manage shipments, bookings and deliveries',           N'Logistics');
INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category) VALUES
    (N'LOG_VIEW',        N'Logistics View',
     N'View shipments and deliveries — read only',                      N'Logistics');
END


/* ── 3. User ↔ Permission junction ─────────────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.PortalUserPermissions') AND type = 'U')
BEGIN
    CREATE TABLE dbo.PortalUserPermissions (
        UserPermissionID INT          NOT NULL IDENTITY(1,1),
        UserID           INT          NOT NULL,
        PermissionCode   NVARCHAR(50) NOT NULL,
        GrantedAt        DATETIME     NOT NULL DEFAULT GETDATE(),
        GrantedByUserID  INT          NULL,
        CONSTRAINT PK_PortalUserPermissions   PRIMARY KEY (UserPermissionID),
        CONSTRAINT UQ_UserPermission          UNIQUE      (UserID, PermissionCode),
        CONSTRAINT FK_UserPerms_User          FOREIGN KEY (UserID)          REFERENCES dbo.PortalUsers      (UserID),
        CONSTRAINT FK_UserPerms_Perm          FOREIGN KEY (PermissionCode)  REFERENCES dbo.PortalPermissions(PermissionCode)
    )

    CREATE INDEX IX_UserPerms_UserID ON dbo.PortalUserPermissions (UserID)
END


/* ── Verify ──────────────────────────────────────────────────────────────── */
SELECT Role, COUNT(*) AS UserCount FROM dbo.PortalUsers GROUP BY Role ORDER BY Role
