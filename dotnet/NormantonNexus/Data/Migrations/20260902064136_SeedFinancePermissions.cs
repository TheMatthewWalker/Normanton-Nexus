using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace NormantonNexus.Data.Migrations
{
    /// <summary>
    /// Finance (Phase 5) permission migration. Unlike Engineering/Quality/
    /// Sales, this does NOT split an existing coarse legacy code — Node's
    /// GL Account Groups writes and the three SAP costing proxies
    /// (Material Costing/Actual Costs/Profit Center Data) currently have no
    /// permission check at all beyond requireLogin, a real gap flagged by
    /// research. FIN_GL_GROUPS_MANAGE is a genuinely new gate for the two
    /// destructive GL-group actions (create/update/delete); read access to
    /// every Finance tile stays Dept:finance-gated only (see
    /// FinanceController), already a tightening over Node's "any logged-in
    /// user of any department." FIN_STOCK_APPROVE (Stock Adjustments) is
    /// untouched here — it's an existing legacy code, already tile-scoped
    /// in Node, assumed already seeded in dbo.PortalPermissions from
    /// Node's own admin-managed data (same assumption every earlier
    /// migration in this app makes about legacy codes it references but
    /// doesn't define).
    ///
    /// No holder-migration INSERT here (unlike every prior Seed*Permissions
    /// migration) — there is no legacy code's existing holders to carry
    /// forward, since this permission didn't exist in any form before now.
    /// The default group below starts empty; an admin grants it to
    /// whoever should manage GL account groups.
    /// </summary>
    public partial class SeedFinancePermissions : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = 'FIN_GL_GROUPS_MANAGE')
                    INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category)
                    VALUES ('FIN_GL_GROUPS_MANAGE', 'Finance: Manage GL Account Groups',
                        'Create, edit, or delete the named GL account groups used by Actual Costs and Profit Center Data.', 'Finance');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroups WHERE GroupName = 'Finance Administrator')
                    INSERT INTO dbo.PortalPermissionGroups (GroupName, Description, CreatedBy)
                    VALUES ('Finance Administrator',
                        'Grants management of GL Account Groups — no legacy code covered this, so no default membership is auto-granted; an admin assigns this group manually.',
                        'migration:SeedFinancePermissions');

                DECLARE @glGroupsGroupId INT = (SELECT GroupID FROM dbo.PortalPermissionGroups WHERE GroupName = 'Finance Administrator');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @glGroupsGroupId AND PermissionCode = 'FIN_GL_GROUPS_MANAGE')
                    INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@glGroupsGroupId, 'FIN_GL_GROUPS_MANAGE');
                """);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Deliberately a no-op — see SeedEngineeringPermissions.Down for the
            // same reasoning.
        }
    }
}
