using Dapper;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Warehouse;

/// <summary>
/// Master-data CRUD for the pallet builder — port of routes/palletdata.js,
/// packagingdata.js, and palletvalidation.js. See
/// WarehouseMasterDataModels.cs's header comment for scope. No validation
/// anywhere in this Helper, matching Node exactly — none of these three
/// routes validate their body, and the UPDATE queries have no rows-affected
/// check (always succeed, even for an unknown ID), same as
/// FailedBackflushHelper.CancelAsync's own precedent for a genuine Node
/// behavior worth preserving rather than tightening unasked.
/// </summary>
internal static class WarehouseMasterDataHelper
{
    internal static async Task<IReadOnlyList<PalletDataRow>> GetPalletDataAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<PalletDataRow>(new CommandDefinition("""
            SELECT palletID AS PalletId, palletDescription AS PalletDescription, palletWeight AS PalletWeight,
                   palletLength AS PalletLength, palletWidth AS PalletWidth, palletHeight AS PalletHeight
            FROM log.PalletData
            """, cancellationToken: ct));
        return rows.ToArray();
    }

    internal static async Task UpdatePalletDataAsync(INexusOperationsDb db, string palletId, UpdatePalletDataRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.PalletData
            SET palletDescription = @description, palletWeight = @weight,
                palletLength = @length, palletWidth = @width, palletHeight = @height
            WHERE palletID = @palletId
            """, new
        {
            palletId,
            description = body.PalletDescription,
            weight = body.PalletWeight,
            length = body.PalletLength,
            width = body.PalletWidth,
            height = body.PalletHeight
        }, cancellationToken: ct));
    }

    internal static async Task<IReadOnlyList<PackagingDataRow>> GetPackagingDataAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<PackagingDataRow>(new CommandDefinition("""
            SELECT packID AS PackId, packMaterial AS PackMaterial, packDescription AS PackDescription, packWeight AS PackWeight,
                   packLength AS PackLength, packWidth AS PackWidth, packHeight AS PackHeight
            FROM log.PackagingData
            """, cancellationToken: ct));
        return rows.ToArray();
    }

    internal static async Task UpdatePackagingDataAsync(INexusOperationsDb db, string packId, UpdatePackagingDataRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.PackagingData
            SET packDescription = @description, packMaterial = @material, packWeight = @weight,
                packLength = @length, packWidth = @width, packHeight = @height
            WHERE packID = @packId
            """, new
        {
            packId,
            description = body.PackDescription,
            material = body.PackMaterial,
            weight = body.PackWeight,
            length = body.PackLength,
            width = body.PackWidth,
            height = body.PackHeight
        }, cancellationToken: ct));
    }

    /// <summary>Pallet-type-scoped valid packaging options, joined with full PackagingData detail — the join createPallet()/the pallet-detail panel actually need. The bare "every pallet type" table (GET /) has no confirmed caller and isn't ported — see the header comment.</summary>
    internal static async Task<IReadOnlyList<PalletValidationRow>> GetValidationForPalletAsync(INexusOperationsDb db, string palletId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<PalletValidationRow>(new CommandDefinition("""
            SELECT pv.palletID AS PalletId, pv.packagingID AS PackagingId,
                   pd.packMaterial AS PackMaterial, pd.packDescription AS PackDescription,
                   pd.packWeight AS PackWeight, pd.packLength AS PackLength, pd.packWidth AS PackWidth, pd.packHeight AS PackHeight
            FROM log.PalletValidation pv
            LEFT JOIN log.PackagingData pd ON pd.packID = pv.packagingID
            WHERE pv.palletID = @palletId
            """, new { palletId }, cancellationToken: ct));
        return rows.ToArray();
    }
}
