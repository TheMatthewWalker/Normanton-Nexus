using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace NormantonNexus.Data.Migrations
{
    /// <summary>
    /// New, additive-only schema for the permission-group redesign — see the
    /// migration plan's "Authorization model" section. Nothing in the
    /// existing PortalUsers/PortalUserDepartments/PortalPermissions/
    /// PortalUserPermissions tables (created by EnsureCoreSchema, or already
    /// present via the Node app's own knex migrations) is renamed or
    /// dropped; these three tables just add a reusable "bundle of tile
    /// permissions" concept on top.
    /// </summary>
    public partial class AddPermissionGroups : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                IF OBJECT_ID('dbo.PortalPermissionGroups', 'U') IS NULL
                BEGIN
                    CREATE TABLE dbo.PortalPermissionGroups (
                        GroupID INT IDENTITY(1,1) NOT NULL,
                        GroupName NVARCHAR(100) NOT NULL,
                        Description NVARCHAR(500) NULL,
                        CreatedBy NVARCHAR(80) NULL,
                        CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                        CONSTRAINT PK_PortalPermissionGroups PRIMARY KEY (GroupID)
                    );
                    CREATE UNIQUE INDEX UX_PortalPermissionGroups_GroupName ON dbo.PortalPermissionGroups (GroupName);
                END
                """);

            migrationBuilder.Sql("""
                IF OBJECT_ID('dbo.PortalPermissionGroupPermissions', 'U') IS NULL
                BEGIN
                    CREATE TABLE dbo.PortalPermissionGroupPermissions (
                        GroupID INT NOT NULL,
                        PermissionCode NVARCHAR(50) NOT NULL,
                        CONSTRAINT PK_PortalPermissionGroupPermissions PRIMARY KEY (GroupID, PermissionCode),
                        CONSTRAINT FK_PortalPermissionGroupPermissions_Group FOREIGN KEY (GroupID)
                            REFERENCES dbo.PortalPermissionGroups (GroupID) ON DELETE CASCADE,
                        CONSTRAINT FK_PortalPermissionGroupPermissions_Permission FOREIGN KEY (PermissionCode)
                            REFERENCES dbo.PortalPermissions (PermissionCode)
                    );
                END
                """);

            migrationBuilder.Sql("""
                IF OBJECT_ID('dbo.PortalUserPermissionGroups', 'U') IS NULL
                BEGIN
                    CREATE TABLE dbo.PortalUserPermissionGroups (
                        UserID INT NOT NULL,
                        GroupID INT NOT NULL,
                        GrantedByUserID INT NULL,
                        GrantedAt DATETIME NOT NULL DEFAULT GETDATE(),
                        CONSTRAINT PK_PortalUserPermissionGroups PRIMARY KEY (UserID, GroupID),
                        CONSTRAINT FK_PortalUserPermissionGroups_User FOREIGN KEY (UserID)
                            REFERENCES dbo.PortalUsers (UserID) ON DELETE CASCADE,
                        CONSTRAINT FK_PortalUserPermissionGroups_Group FOREIGN KEY (GroupID)
                            REFERENCES dbo.PortalPermissionGroups (GroupID) ON DELETE CASCADE
                    );
                END
                """);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP TABLE IF EXISTS dbo.PortalUserPermissionGroups;");
            migrationBuilder.Sql("DROP TABLE IF EXISTS dbo.PortalPermissionGroupPermissions;");
            migrationBuilder.Sql("DROP TABLE IF EXISTS dbo.PortalPermissionGroups;");
        }
    }
}
