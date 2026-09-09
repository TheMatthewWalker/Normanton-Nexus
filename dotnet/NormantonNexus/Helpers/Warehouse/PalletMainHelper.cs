using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Warehouse;

/// <summary>Pallet header CRUD — port of routes/palletmain.js. Only GET id/:id, POST, and PATCH have a confirmed live frontend caller (see dotnet/CLAUDE.md's Sub-phase 7b notes) — the bare GET /, GET /category/:c, GET /location/:l, and landing-sparkline are not ported.</summary>
internal static class PalletMainHelper
{
    internal static async Task<IReadOnlyList<PalletMainRow>> GetByIdAsync(INexusOperationsDb db, int palletId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<PalletMainRow>(new CommandDefinition("""
            SELECT palletID AS PalletId, palletType AS PalletType, palletFinish AS PalletFinish, packagingWeight AS PackagingWeight,
                   grossWeight AS GrossWeight, palletVolume AS PalletVolume, palletLength AS PalletLength, palletWidth AS PalletWidth,
                   palletHeight AS PalletHeight, palletRemoved AS PalletRemoved, palletCategory AS PalletCategory,
                   palletLocation AS PalletLocation, palletCreationDate AS PalletCreationDate, palletFinishDate AS PalletFinishDate
            FROM log.PalletMain WHERE palletID = @palletId
            """, new { palletId }, cancellationToken: ct));
        return rows.ToArray();
    }

    /// <summary>palletID is an IDENTITY column — SQL Server assigns it, read back via SCOPE_IDENTITY().</summary>
    internal static async Task<CreatePalletResult> CreateAsync(INexusOperationsDb db, CreatePalletRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var palletId = await connection.QuerySingleAsync<int>(new CommandDefinition("""
            INSERT INTO log.PalletMain
                (palletType, palletFinish, packagingWeight, grossWeight,
                 palletVolume, palletLength, palletWidth, palletHeight,
                 palletRemoved, palletCategory, palletLocation, palletCreationDate, palletFinishDate)
            VALUES
                (@palletType, @palletFinish, @packagingWeight, @grossWeight,
                 @palletVolume, @palletLength, @palletWidth, @palletHeight,
                 @palletRemoved, @palletCategory, @palletLocation, @palletCreationDate, @palletFinishDate);
            SELECT CAST(SCOPE_IDENTITY() AS INT);
            """, new
        {
            palletType = body.PalletType,
            palletFinish = body.PalletFinish,
            packagingWeight = body.PackagingWeight,
            grossWeight = body.GrossWeight,
            palletVolume = body.PalletVolume,
            palletLength = body.PalletLength,
            palletWidth = body.PalletWidth,
            palletHeight = body.PalletHeight,
            palletRemoved = body.PalletRemoved,
            palletCategory = body.PalletCategory,
            palletLocation = body.PalletLocation,
            palletCreationDate = body.PalletCreationDate,
            palletFinishDate = body.PalletFinishDate
        }, cancellationToken: ct));

        return new CreatePalletResult(palletId);
    }

    private static bool HasAnyUpdateValue(UpdatePalletRequest body) =>
        body.PalletFinish is not null || body.PalletLocation is not null || body.PalletCategory is not null
        || body.GrossWeight is not null || body.PackagingWeight is not null || body.PalletVolume is not null
        || body.PalletRemoved is not null || body.PalletType is not null || body.PalletLength is not null
        || body.PalletWidth is not null || body.PalletHeight is not null;

    /// <summary>
    /// Deleting a pallet must also reverse every SAP transfer order it
    /// staged — otherwise the pallet disappears from the app while its
    /// batches are still sitting in the picksheet's 916 bin, blocking that
    /// stock for every other delivery. Each package is reversed
    /// independently (no atomic multi-call SAP transaction available
    /// here); if any fail, the pallet is NOT marked removed (and no other
    /// field on the request is applied either, matching Node's own early
    /// return before the update query even runs), so it stays visible with
    /// whatever did reverse already reversed, and the operator can see
    /// exactly what's still stuck.
    /// </summary>
    internal static async Task<PalletUpdateResult> UpdateAsync(INexusOperationsDb db, ISapServerClient sap, int palletId, UpdatePalletRequest body, int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        if (body.PalletRemoved == true)
        {
            var packages = (await connection.QueryAsync<StagedPackageInfo>(new CommandDefinition("""
                SELECT palletItemID AS PalletItemId, sapMaterial AS SapMaterial, sapBatch AS SapBatch, sapDelivery AS SapDelivery,
                       sapSourceStorageType AS SapSourceStorageType, sapSourceBin AS SapSourceBin
                FROM log.PalletPackages WHERE palletID = @palletId
                """, new { palletId }, cancellationToken: ct))).ToList();

            var failures = new List<PalletRemovalFailure>();
            foreach (var pkg in packages)
            {
                var reversal = await SapStagingHelper.ReverseStagedPackageAsync(sap, pkg, userId, ct);
                if (reversal.Attempted && !reversal.Success)
                {
                    failures.Add(new PalletRemovalFailure(pkg.PalletItemId, pkg.SapMaterial, pkg.SapBatch, reversal.Error));
                }
            }

            if (failures.Count > 0)
            {
                return new PalletUpdateResult(false, $"Could not reverse SAP staging for {failures.Count} package(s) — pallet not removed.", failures);
            }
        }

        if (!HasAnyUpdateValue(body))
        {
            throw new NexusValidationException("Nothing to update");
        }

        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.PalletMain SET
                palletFinish      = COALESCE(@palletFinish, palletFinish),
                palletFinishDate  = CASE WHEN @palletFinish = 1 THEN GETDATE() ELSE palletFinishDate END,
                palletLocation    = COALESCE(@palletLocation, palletLocation),
                palletCategory    = COALESCE(@palletCategory, palletCategory),
                grossWeight       = COALESCE(@grossWeight, grossWeight),
                packagingWeight   = COALESCE(@packagingWeight, packagingWeight),
                palletVolume      = COALESCE(@palletVolume, palletVolume),
                palletRemoved     = COALESCE(@palletRemoved, palletRemoved),
                palletType        = COALESCE(@palletType, palletType),
                palletLength      = COALESCE(@palletLength, palletLength),
                palletWidth       = COALESCE(@palletWidth, palletWidth),
                palletHeight      = COALESCE(@palletHeight, palletHeight)
            WHERE palletID = @palletId
            """, new
        {
            palletId,
            palletFinish = body.PalletFinish,
            palletLocation = body.PalletLocation,
            palletCategory = body.PalletCategory,
            grossWeight = body.GrossWeight,
            packagingWeight = body.PackagingWeight,
            palletVolume = body.PalletVolume,
            palletRemoved = body.PalletRemoved,
            palletType = body.PalletType,
            palletLength = body.PalletLength,
            palletWidth = body.PalletWidth,
            palletHeight = body.PalletHeight
        }, cancellationToken: ct));

        return new PalletUpdateResult(true, null, null);
    }
}
