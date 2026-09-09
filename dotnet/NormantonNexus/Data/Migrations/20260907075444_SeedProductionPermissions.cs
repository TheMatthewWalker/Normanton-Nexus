using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace NormantonNexus.Data.Migrations
{
    /// <summary>
    /// Production (Phase 6) permission migration — the largest per-tile split
    /// in this migration. PROD_SUPERVISOR was confirmed the single
    /// widest-reaching legacy code (26 routes across every Production
    /// controller action gated by it) and, unlike WAREHOUSE_OP/VENDOR_CONSIGNMENT/
    /// FIN_STOCK_APPROVE (each already one coherent capability Node itself
    /// never further distinguished), it genuinely sprawls across unrelated
    /// features — reports, run cancellation, batch history, traceability,
    /// scrap approval, SAP/scrap reversal, and failed-backflush retry are all
    /// independently meaningful things to grant or withhold. Same
    /// per-department migration path as every earlier phase (see the plan's
    /// "Authorization model"): (a) one new fine-grained code per tile, (b) one
    /// default group reproducing PROD_SUPERVISOR's current blanket access
    /// (Node never distinguished these tiles from each other either — a flat
    /// PROD_SUPERVISOR grant meant "all of it"), (c) migrate existing
    /// PROD_SUPERVISOR holders into that group. (d) retiring PROD_SUPERVISOR
    /// itself is deliberately NOT done — see this migration's own comment
    /// on why it stays registered.
    /// </summary>
    public partial class SeedProductionPermissions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = 'PROD_REPORTS_VIEW')
                    INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category)
                    VALUES ('PROD_REPORTS_VIEW', 'Production: Reports',
                        'View Production''s report suite (Output, Scrap, SAP Performance, Batches, Shift Comparison, Operator Output, Material Output) — presented as one Reports section in Node, so kept as one code rather than seven.', 'Production');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = 'PROD_OPEN_RUNS')
                    INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category)
                    VALUES ('PROD_OPEN_RUNS', 'Production: Open Runs',
                        'View open (in-progress) production runs and cancel one.', 'Production');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = 'PROD_BATCH_HISTORY')
                    INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category)
                    VALUES ('PROD_BATCH_HISTORY', 'Production: Batch History',
                        'Search historical production batch records. Also usable by anyone holding PROD_TRACEABILITY, since Traceability searches history as its own first step.', 'Production');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = 'PROD_TRACEABILITY')
                    INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category)
                    VALUES ('PROD_TRACEABILITY', 'Production: Traceability',
                        'Trace a production batch''s raw-material consumption and downstream linkage.', 'Production');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = 'PROD_SCRAP_APPROVE')
                    INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category)
                    VALUES ('PROD_SCRAP_APPROVE', 'Production: Approve Scrap',
                        'Approve or reject a pending scrap posting.', 'Production');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = 'PROD_SCRAP_RETRY')
                    INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category)
                    VALUES ('PROD_SCRAP_RETRY', 'Production: Retry Posted Scrap',
                        'View the Posted Scrap queue and retry a scrap posting that failed to reach SAP.', 'Production');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = 'PROD_SAP_REVERSAL')
                    INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category)
                    VALUES ('PROD_SAP_REVERSAL', 'Production: SAP Reversals',
                        'Reverse a posted backflush/goods-movement SAP document.', 'Production');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = 'PROD_SCRAP_REVERSAL')
                    INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category)
                    VALUES ('PROD_SCRAP_REVERSAL', 'Production: Scrap Reversal',
                        'View missed scrap reversals and reverse a posted scrap SAP document.', 'Production');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = 'PROD_FAILED_BACKFLUSH')
                    INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category)
                    VALUES ('PROD_FAILED_BACKFLUSH', 'Production: Failed Backflush',
                        'View, retry, or cancel a backflush posting that failed to reach SAP. No frontend page consumes this yet (deferred, same as the API routes it gates) — seeded now so the backend is already correctly gated when one is built.', 'Production');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroups WHERE GroupName = 'Production Supervisor')
                    INSERT INTO dbo.PortalPermissionGroups (GroupName, Description, CreatedBy)
                    VALUES ('Production Supervisor',
                        'Default group reproducing the legacy PROD_SUPERVISOR permission''s effective access across every tile it used to gate at once (reports, open runs, batch history, traceability, scrap approve/retry, SAP/scrap reversal, failed backflush).',
                        'migration:SeedProductionPermissions');

                DECLARE @groupId INT = (SELECT GroupID FROM dbo.PortalPermissionGroups WHERE GroupName = 'Production Supervisor');

                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @groupId AND PermissionCode = 'PROD_REPORTS_VIEW')
                    INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@groupId, 'PROD_REPORTS_VIEW');
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @groupId AND PermissionCode = 'PROD_OPEN_RUNS')
                    INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@groupId, 'PROD_OPEN_RUNS');
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @groupId AND PermissionCode = 'PROD_BATCH_HISTORY')
                    INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@groupId, 'PROD_BATCH_HISTORY');
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @groupId AND PermissionCode = 'PROD_TRACEABILITY')
                    INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@groupId, 'PROD_TRACEABILITY');
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @groupId AND PermissionCode = 'PROD_SCRAP_APPROVE')
                    INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@groupId, 'PROD_SCRAP_APPROVE');
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @groupId AND PermissionCode = 'PROD_SCRAP_RETRY')
                    INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@groupId, 'PROD_SCRAP_RETRY');
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @groupId AND PermissionCode = 'PROD_SAP_REVERSAL')
                    INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@groupId, 'PROD_SAP_REVERSAL');
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @groupId AND PermissionCode = 'PROD_SCRAP_REVERSAL')
                    INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@groupId, 'PROD_SCRAP_REVERSAL');
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @groupId AND PermissionCode = 'PROD_FAILED_BACKFLUSH')
                    INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@groupId, 'PROD_FAILED_BACKFLUSH');

                -- PROD_SUPERVISOR itself is ALSO bundled into the new group — not as
                -- an authorization gate (nothing checks it via [Authorize] anymore
                -- after this migration lands), but because Helpers/Warehouse/
                -- StagingHelper.cs's low-stock alert on a Staging Post request fans
                -- out to NotificationTargetType.Permission="PROD_SUPERVISOR" directly.
                -- NotificationService.FanOutAsync resolves a Permission target via
                -- BOTH direct PortalUserPermissions AND group-bundled
                -- PortalPermissionGroupPermissions, so a legacy direct PROD_SUPERVISOR
                -- holder keeps receiving that alert unchanged (their direct grant is
                -- untouched by this migration — see below), and a supervisor added
                -- through the new Groups UI going forward (who never holds the old
                -- direct grant at all) still receives it too, via this bundled row.
                IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissionGroupPermissions WHERE GroupID = @groupId AND PermissionCode = 'PROD_SUPERVISOR')
                    INSERT INTO dbo.PortalPermissionGroupPermissions (GroupID, PermissionCode) VALUES (@groupId, 'PROD_SUPERVISOR');

                -- Every user who currently holds the legacy PROD_SUPERVISOR grant keeps
                -- equivalent access by being added to the new default group — nobody
                -- silently loses Production supervisor access just because
                -- ProductionNexusController (and every Pages/Production/* page) checks
                -- the new per-tile codes instead.
                INSERT INTO dbo.PortalUserPermissionGroups (UserID, GroupID, GrantedByUserID, GrantedAt)
                SELECT DISTINCT up.UserID, @groupId, NULL, GETDATE()
                FROM dbo.PortalUserPermissions up
                WHERE up.PermissionCode = 'PROD_SUPERVISOR'
                  AND NOT EXISTS (
                      SELECT 1 FROM dbo.PortalUserPermissionGroups ug
                      WHERE ug.UserID = up.UserID AND ug.GroupID = @groupId
                  );
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Deliberately a no-op — same reasoning as every earlier department's
            // seed migration (see e.g. SeedEngineeringPermissions.Down). Roll back
            // by restoring from a backup if this is ever genuinely needed.
        }
    }
}
