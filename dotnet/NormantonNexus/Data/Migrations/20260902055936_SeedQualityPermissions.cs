using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace NormantonNexus.Data.Migrations
{
    /// <summary>
    /// Quality (Phase 3) permission migration — see SeedEngineeringPermissions
    /// for the pattern this repeats. Splits the legacy QUAL_BLOCKING (covered
    /// both Block AND Unblock, including both directions of the Bulk endpoint)
    /// into two per-tile codes, and 1:1-replaces QUAL_CONCESSION for the
    /// review (approve/reject) action this phase ports — see
    /// QualityHelper.ReviewConcessionAsync's own comments for why the
    /// raise-a-concession side (Production-domain) isn't covered yet.
    /// </summary>
    public partial class SeedQualityPermissions : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = 'QUAL_BLOCK_STOCK')
                    INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category)
                    VALUES ('QUAL_BLOCK_STOCK', 'Quality: Block Stock',
                        'Move stock to quality inspection via MB1B movement 344 (single or bulk).', 'Quality');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = 'QUAL_UNBLOCK_STOCK')
                    INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category)
                    VALUES ('QUAL_UNBLOCK_STOCK', 'Quality: Unblock Stock',
                        'Release stock from quality inspection via MB1B movement 343 (single or bulk).', 'Quality');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = 'QUAL_TRACEABILITY_CONCESSION')
                    INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category)
                    VALUES ('QUAL_TRACEABILITY_CONCESSION', 'Quality: Traceability Concession Review',
                        'Approve or reject Production''s requests to proceed with a BOM traceability mismatch.', 'Quality');

                -- Default group reproducing QUAL_BLOCKING's current combined
                -- access (block AND unblock, including bulk of either
                -- direction — see QualityHelper's own comments on this).
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroups WHERE GroupName = 'Quality Blocking')
                    INSERT INTO dbo.PortalPermissionGroups (GroupName, Description, CreatedBy)
                    VALUES ('Quality Blocking',
                        'Default group reproducing the legacy QUAL_BLOCKING permission''s effective access (both Block Stock and Unblock Stock).',
                        'migration:SeedQualityPermissions');

                DECLARE @blockingGroupId INT = (SELECT GroupID FROM dbo.PortalPermissionGroups WHERE GroupName = 'Quality Blocking');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @blockingGroupId AND PermissionCode = 'QUAL_BLOCK_STOCK')
                    INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@blockingGroupId, 'QUAL_BLOCK_STOCK');
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @blockingGroupId AND PermissionCode = 'QUAL_UNBLOCK_STOCK')
                    INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@blockingGroupId, 'QUAL_UNBLOCK_STOCK');

                INSERT INTO dbo.PortalUserPermissionGroups (UserID, GroupID, GrantedByUserID, GrantedAt)
                SELECT DISTINCT up.UserID, @blockingGroupId, NULL, GETDATE()
                FROM dbo.PortalUserPermissions up
                WHERE up.PermissionCode = 'QUAL_BLOCKING'
                  AND NOT EXISTS (
                      SELECT 1 FROM dbo.PortalUserPermissionGroups ug
                      WHERE ug.UserID = up.UserID AND ug.GroupID = @blockingGroupId
                  );

                -- Default group reproducing QUAL_CONCESSION's current
                -- effective access for the review action ONLY (the Production-side
                -- raise-a-concession action isn't ported by this migration —
                -- see this migration's own class comment).
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroups WHERE GroupName = 'Quality Traceability Concession Review')
                    INSERT INTO dbo.PortalPermissionGroups (GroupName, Description, CreatedBy)
                    VALUES ('Quality Traceability Concession Review',
                        'Default group reproducing the legacy QUAL_CONCESSION permission''s effective access for reviewing (approving/rejecting) concessions.',
                        'migration:SeedQualityPermissions');

                DECLARE @concessionGroupId INT = (SELECT GroupID FROM dbo.PortalPermissionGroups WHERE GroupName = 'Quality Traceability Concession Review');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @concessionGroupId AND PermissionCode = 'QUAL_TRACEABILITY_CONCESSION')
                    INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@concessionGroupId, 'QUAL_TRACEABILITY_CONCESSION');

                INSERT INTO dbo.PortalUserPermissionGroups (UserID, GroupID, GrantedByUserID, GrantedAt)
                SELECT DISTINCT up.UserID, @concessionGroupId, NULL, GETDATE()
                FROM dbo.PortalUserPermissions up
                WHERE up.PermissionCode = 'QUAL_CONCESSION'
                  AND NOT EXISTS (
                      SELECT 1 FROM dbo.PortalUserPermissionGroups ug
                      WHERE ug.UserID = up.UserID AND ug.GroupID = @concessionGroupId
                  );
                """);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Deliberately a no-op — see SeedEngineeringPermissions.Down for the
            // same reasoning (legacy codes are never deleted, and reversing the
            // data migration can't distinguish migration-added group memberships
            // from later manual admin grants).
        }
    }
}
