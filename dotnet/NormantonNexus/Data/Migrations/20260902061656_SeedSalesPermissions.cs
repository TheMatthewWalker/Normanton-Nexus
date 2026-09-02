using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace NormantonNexus.Data.Migrations
{
    /// <summary>
    /// Sales (Phase 4) permission migration. Splits the legacy
    /// SALES_SUPERVISOR — which covered both the Sales-only Customer
    /// Standard Instructions writes AND (via Node's requireAnyPermission
    /// with PROD_SUPERVISOR) the shared Production Schedule comment/ETA
    /// edit — into two distinct per-tile codes: SALES_CUSTOMER_INSTRUCTIONS
    /// (Sales-only) and PROD_SCHEDULE_EDIT (shared with Production).
    /// PROD_SCHEDULE_EDIT's default group deliberately migrates holders of
    /// EITHER legacy code (SALES_SUPERVISOR or PROD_SUPERVISOR), matching
    /// today's OR-of-two-codes gate exactly.
    /// </summary>
    public partial class SeedSalesPermissions : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = 'SALES_CUSTOMER_INSTRUCTIONS')
                    INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category)
                    VALUES ('SALES_CUSTOMER_INSTRUCTIONS', 'Sales: Customer Standard Instructions',
                        'Create, edit, bulk-import, or delete customer standard instructions printed on every Drumming Ticket.', 'Sales');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = 'PROD_SCHEDULE_EDIT')
                    INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category)
                    VALUES ('PROD_SCHEDULE_EDIT', 'Production Schedule: Edit Comment / ETA',
                        'Save a comment and/or ETA override against a Production Schedule or Arrears line. Shared between Sales and Production.', 'Sales');

                -- Default group reproducing SALES_SUPERVISOR's Sales-only access.
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroups WHERE GroupName = 'Sales Supervisor')
                    INSERT INTO dbo.PortalPermissionGroups (GroupName, Description, CreatedBy)
                    VALUES ('Sales Supervisor',
                        'Default group reproducing the legacy SALES_SUPERVISOR permission''s Customer Standard Instructions access.',
                        'migration:SeedSalesPermissions');

                DECLARE @salesGroupId INT = (SELECT GroupID FROM dbo.PortalPermissionGroups WHERE GroupName = 'Sales Supervisor');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @salesGroupId AND PermissionCode = 'SALES_CUSTOMER_INSTRUCTIONS')
                    INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@salesGroupId, 'SALES_CUSTOMER_INSTRUCTIONS');

                INSERT INTO dbo.PortalUserPermissionGroups (UserID, GroupID, GrantedByUserID, GrantedAt)
                SELECT DISTINCT up.UserID, @salesGroupId, NULL, GETDATE()
                FROM dbo.PortalUserPermissions up
                WHERE up.PermissionCode = 'SALES_SUPERVISOR'
                  AND NOT EXISTS (
                      SELECT 1 FROM dbo.PortalUserPermissionGroups ug
                      WHERE ug.UserID = up.UserID AND ug.GroupID = @salesGroupId
                  );

                -- Default group reproducing the shared Production Schedule edit
                -- access — anyone who currently holds EITHER legacy code gets it,
                -- matching Node's requireAnyPermission(['PROD_SUPERVISOR','SALES_SUPERVISOR']).
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroups WHERE GroupName = 'Production Schedule Editor')
                    INSERT INTO dbo.PortalPermissionGroups (GroupName, Description, CreatedBy)
                    VALUES ('Production Schedule Editor',
                        'Default group reproducing the legacy PROD_SUPERVISOR/SALES_SUPERVISOR (either one) Production Schedule comment/ETA edit access.',
                        'migration:SeedSalesPermissions');

                DECLARE @scheduleGroupId INT = (SELECT GroupID FROM dbo.PortalPermissionGroups WHERE GroupName = 'Production Schedule Editor');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @scheduleGroupId AND PermissionCode = 'PROD_SCHEDULE_EDIT')
                    INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@scheduleGroupId, 'PROD_SCHEDULE_EDIT');

                -- A user can hold BOTH legacy codes at once, so this dedupes
                -- UserID in its own subquery first (a plain equality filter,
                -- as EnsureCoreSchema/Quality's migrations use, can't have this
                -- problem — UQ_UserPermission already guarantees one row per
                -- (UserID, PermissionCode)). SELECT DISTINCT on the outer
                -- query alone would NOT be safe here: GETDATE() is evaluated
                -- per output row, so two source rows for the same UserID
                -- (one per legacy code) could get different GETDATE() values
                -- and both survive DISTINCT as "different" rows, then collide
                -- on the (UserID, GroupID) primary key when inserted.
                INSERT INTO dbo.PortalUserPermissionGroups (UserID, GroupID, GrantedByUserID, GrantedAt)
                SELECT up.UserID, @scheduleGroupId, NULL, GETDATE()
                FROM (
                    SELECT DISTINCT UserID FROM dbo.PortalUserPermissions
                    WHERE PermissionCode IN ('PROD_SUPERVISOR', 'SALES_SUPERVISOR')
                ) up
                WHERE NOT EXISTS (
                    SELECT 1 FROM dbo.PortalUserPermissionGroups ug
                    WHERE ug.UserID = up.UserID AND ug.GroupID = @scheduleGroupId
                );
                """);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Deliberately a no-op — see SeedEngineeringPermissions.Down for the
            // same reasoning.
        }
    }
}
