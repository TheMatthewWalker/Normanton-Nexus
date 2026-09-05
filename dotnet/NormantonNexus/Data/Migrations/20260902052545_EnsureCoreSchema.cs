using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace NormantonNexus.Data.Migrations
{
    /// <summary>
    /// Idempotently creates the core portal tables this app depends on
    /// (PortalUsers, PortalUserDepartments, PortalPermissions,
    /// PortalUserPermissions, PortalSessions, PortalAuditLog) if they don't
    /// already exist — guarded by IF OBJECT_ID(...) IS NULL, mirroring the
    /// existing Node app's knex-migrations-are-really-just-raw-idempotent-T-SQL
    /// pattern (28 files under migrations/nexus/, IF COL_LENGTH(...) IS NULL-style
    /// guards). Column shapes are copied verbatim from
    /// migrations/nexus/20260804120000_initial_schema.cjs and
    /// 20260804152315_add_must_change_password_to_portal_users.cjs and
    /// sql/migrate_portal_sessions.sql — this migration does NOT change
    /// anything about a database that already has these tables (e.g. one
    /// already migrated by the Node app's own knex tooling); it only fills
    /// the gap for a genuinely fresh database (see the migration plan's
    /// "new SQL Server, no schema yet" scenario).
    /// </summary>
    public partial class EnsureCoreSchema : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                IF OBJECT_ID('dbo.PortalUsers', 'U') IS NULL
                BEGIN
                    CREATE TABLE dbo.PortalUsers (
                        UserID INT IDENTITY(1,1) NOT NULL,
                        Username NVARCHAR(80) NOT NULL,
                        Email NVARCHAR(160) NOT NULL,
                        PasswordHash NVARCHAR(256) NOT NULL,
                        Role NVARCHAR(20) NOT NULL,
                        IsActive BIT NOT NULL DEFAULT 0,
                        IsLocked BIT NOT NULL DEFAULT 0,
                        FailedLogins INT NOT NULL DEFAULT 0,
                        CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                        LastLogin DATETIME NULL,
                        ApprovedBy NVARCHAR(80) NULL,
                        ApprovedAt DATETIME NULL,
                        Notes NVARCHAR(500) NULL,
                        FirstName NVARCHAR(80) NULL,
                        LastName NVARCHAR(80) NULL,
                        DefaultPrinterID NVARCHAR(50) NULL,
                        ShortIdleTimeout BIT NOT NULL DEFAULT 0,
                        reset_token VARCHAR(255) NULL,
                        reset_token_expires DATETIME NULL,
                        SapUsername NVARCHAR(40) NULL,
                        SapPasswordEncrypted NVARCHAR(400) NULL,
                        SapCredentialUpdatedAt DATETIME NULL,
                        MustChangePassword BIT NOT NULL DEFAULT 0,
                        CONSTRAINT PK_PortalUsers PRIMARY KEY (UserID),
                        CONSTRAINT CK_PortalUsers_Role CHECK (Role IN ('superadmin', 'admin', 'operator'))
                    );
                    CREATE UNIQUE INDEX UX_PortalUsers_Username ON dbo.PortalUsers (Username);
                    CREATE UNIQUE INDEX UX_PortalUsers_Email ON dbo.PortalUsers (Email);
                END
                """);

            migrationBuilder.Sql("""
                IF OBJECT_ID('dbo.PortalUserDepartments', 'U') IS NULL
                BEGIN
                    CREATE TABLE dbo.PortalUserDepartments (
                        ID INT IDENTITY(1,1) NOT NULL,
                        UserID INT NOT NULL,
                        Department NVARCHAR(50) NOT NULL,
                        GrantedBy NVARCHAR(80) NULL,
                        GrantedAt DATETIME NOT NULL DEFAULT GETDATE(),
                        CONSTRAINT PK_PortalUserDepartments PRIMARY KEY (ID),
                        CONSTRAINT FK_PortalUserDepartments_PortalUsers FOREIGN KEY (UserID)
                            REFERENCES dbo.PortalUsers (UserID) ON DELETE CASCADE,
                        CONSTRAINT CK_PortalUserDepartments_Department CHECK (Department IN (
                            'management', 'engineering', 'quality', 'sales',
                            'finance', 'warehouse', 'logistics', 'production'))
                    );
                    CREATE UNIQUE INDEX UX_UserDept ON dbo.PortalUserDepartments (UserID, Department);
                END
                """);

            migrationBuilder.Sql("""
                IF OBJECT_ID('dbo.PortalPermissions', 'U') IS NULL
                BEGIN
                    CREATE TABLE dbo.PortalPermissions (
                        PermissionCode NVARCHAR(50) NOT NULL,
                        PermissionName NVARCHAR(100) NOT NULL,
                        Description NVARCHAR(500) NULL,
                        Category NVARCHAR(50) NOT NULL DEFAULT 'General',
                        CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                        CONSTRAINT PK_PortalPermissions PRIMARY KEY (PermissionCode)
                    );
                END
                """);

            migrationBuilder.Sql("""
                IF OBJECT_ID('dbo.PortalUserPermissions', 'U') IS NULL
                BEGIN
                    CREATE TABLE dbo.PortalUserPermissions (
                        UserPermissionID INT IDENTITY(1,1) NOT NULL,
                        UserID INT NOT NULL,
                        PermissionCode NVARCHAR(50) NOT NULL,
                        GrantedAt DATETIME NOT NULL DEFAULT GETDATE(),
                        GrantedByUserID INT NULL,
                        CONSTRAINT PK_PortalUserPermissions PRIMARY KEY (UserPermissionID),
                        CONSTRAINT UQ_UserPermission UNIQUE (UserID, PermissionCode),
                        CONSTRAINT FK_PortalUserPermissions_PortalUsers FOREIGN KEY (UserID)
                            REFERENCES dbo.PortalUsers (UserID) ON DELETE CASCADE,
                        CONSTRAINT FK_PortalUserPermissions_PortalPermissions FOREIGN KEY (PermissionCode)
                            REFERENCES dbo.PortalPermissions (PermissionCode)
                    );
                    CREATE INDEX IX_UserPerms_UserID ON dbo.PortalUserPermissions (UserID);
                END
                """);

            migrationBuilder.Sql("""
                IF OBJECT_ID('dbo.PortalSessions', 'U') IS NULL
                BEGIN
                    CREATE TABLE dbo.PortalSessions (
                        SessionID NVARCHAR(128) NOT NULL,
                        SessionData NVARCHAR(MAX) NOT NULL,
                        ExpiresUtc DATETIME NOT NULL,
                        CreatedUtc DATETIME NOT NULL DEFAULT GETUTCDATE(),
                        UpdatedUtc DATETIME NOT NULL DEFAULT GETUTCDATE(),
                        CONSTRAINT PK_PortalSessions PRIMARY KEY (SessionID)
                    );
                    CREATE INDEX IX_PortalSessions_Expires ON dbo.PortalSessions (ExpiresUtc);
                END
                """);

            migrationBuilder.Sql("""
                IF OBJECT_ID('dbo.PortalAuditLog', 'U') IS NULL
                BEGIN
                    CREATE TABLE dbo.PortalAuditLog (
                        LogID INT IDENTITY(1,1) NOT NULL,
                        EventTime DATETIME NOT NULL DEFAULT GETDATE(),
                        Username NVARCHAR(80) NULL,
                        EventType NVARCHAR(50) NOT NULL,
                        Detail NVARCHAR(500) NULL,
                        IPAddress NVARCHAR(50) NULL,
                        CONSTRAINT PK_PortalAuditLog PRIMARY KEY (LogID)
                    );
                END
                """);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Deliberately a no-op: these tables may be shared with the live
            // Node app (see the migration plan's "Schema stays as-is"
            // principle) — dropping them on a migration rollback would be
            // catastrophic if this ever ran against a database the Node app
            // is also using. Roll back by restoring from a backup, not by
            // running this migration's Down().
        }
    }
}
