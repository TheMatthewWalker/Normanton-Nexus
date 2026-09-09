using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace NormantonNexus.Data.Migrations
{
    /// <summary>
    /// Engineering (Phase 2) permission migration — see the plan's
    /// per-department migration path in "Authorization model": (a) define
    /// one new fine-grained code per tile, (b) create a default group
    /// reproducing the legacy coarse code's effective access, (c) migrate
    /// existing grants of the legacy code into membership of that group.
    /// (d) retiring MASTER_DATA itself is deliberately NOT done here — see
    /// this migration's own Down() comment.
    /// </summary>
    public partial class SeedEngineeringPermissions : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = 'ENG_MASS_UPDATE')
                    INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category)
                    VALUES ('ENG_MASS_UPDATE', 'Engineering: Mass Packaging Update',
                        'Bulk-update the default (plant-level) packaging instruction assignment for a list of part numbers.', 'Engineering');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = 'ENG_NEW_PACKAGING')
                    INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category)
                    VALUES ('ENG_NEW_PACKAGING', 'Engineering: New Customer Packaging Creation',
                        'Create the material masters and BOMs needed for a customer packaging set-up.', 'Engineering');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = 'ENG_INSTRUCTION_DETAIL')
                    INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category)
                    VALUES ('ENG_INSTRUCTION_DETAIL', 'Engineering: Packaging Instruction Detail',
                        'Create, update, or delete a material''s packaging instruction (plant-default or per customer).', 'Engineering');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroups WHERE GroupName = 'Engineering Master Data')
                    INSERT INTO dbo.PortalPermissionGroups (GroupName, Description, CreatedBy)
                    VALUES ('Engineering Master Data',
                        'Default group reproducing the legacy MASTER_DATA permission''s effective access across all three Engineering Packaging Data tiles.',
                        'migration:SeedEngineeringPermissions');

                DECLARE @groupId INT = (SELECT GroupID FROM dbo.PortalPermissionGroups WHERE GroupName = 'Engineering Master Data');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @groupId AND PermissionCode = 'ENG_MASS_UPDATE')
                    INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@groupId, 'ENG_MASS_UPDATE');
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @groupId AND PermissionCode = 'ENG_NEW_PACKAGING')
                    INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@groupId, 'ENG_NEW_PACKAGING');
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @groupId AND PermissionCode = 'ENG_INSTRUCTION_DETAIL')
                    INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@groupId, 'ENG_INSTRUCTION_DETAIL');

                -- Every user who currently holds the legacy MASTER_DATA grant keeps
                -- equivalent access by being added to the new default group — nobody
                -- silently loses Engineering write access just because
                -- EngineeringController checks the new per-tile codes instead.
                INSERT INTO dbo.PortalUserPermissionGroups (UserID, GroupID, GrantedByUserID, GrantedAt)
                SELECT DISTINCT up.UserID, @groupId, NULL, GETDATE()
                FROM dbo.PortalUserPermissions up
                WHERE up.PermissionCode = 'MASTER_DATA'
                  AND NOT EXISTS (
                      SELECT 1 FROM dbo.PortalUserPermissionGroups ug
                      WHERE ug.UserID = up.UserID AND ug.GroupID = @groupId
                  );
                """);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Deliberately a no-op. MASTER_DATA itself is never deleted by this
            // migration (retiring a legacy code is a separate, later cleanup —
            // see the migration plan — once this pattern has been confirmed
            // working for real), and cleanly reversing the data migration step
            // (which users were added to the new group *because* of this
            // migration vs. by a later manual admin action) can't be done
            // safely without tracking that provenance, which isn't worth
            // building for a rollback path. Roll back by restoring from a
            // backup if this is ever genuinely needed.
        }
    }
}
