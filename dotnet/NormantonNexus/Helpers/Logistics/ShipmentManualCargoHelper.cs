using Dapper;
using Microsoft.Extensions.Options;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Manual Outbound Shipment cargo lines + create-folder — Logistics
/// Sub-phase 8a.2. Port of routes/shipmentmain.js's manual-cargo
/// GET/POST/PATCH/DELETE and :shipmentId/create-folder. See
/// ShipmentManualCargoModels.cs's header comment for why documents/folder,
/// documents/:fileName and documents/upload moved to 8a.3 instead.
/// </summary>
internal static class ShipmentManualCargoHelper
{
    internal static async Task<IReadOnlyList<ManualCargoItemRow>> GetCargoAsync(INexusOperationsDb db, long shipmentId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ManualCargoItemRow>(new CommandDefinition("""
            SELECT CargoID AS CargoId, ShipmentID AS ShipmentId, Description, PackageCount, Weight, Length, Width, Height, Volume, CreatedAtUtc, CreatedBy
            FROM log.ManualCargoItem WHERE ShipmentID = @shipmentId AND Removed = 0 ORDER BY CargoID ASC
            """, new { shipmentId }, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task CreateAsync(INexusOperationsDb db, long shipmentId, CreateManualCargoItemRequest body, string? actor, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var isManual = await connection.QuerySingleOrDefaultAsync<bool?>(new CommandDefinition(
            "SELECT IsManual FROM log.ShipmentMain WHERE shipmentID = @shipmentId", new { shipmentId }, cancellationToken: ct));
        if (isManual is null) throw new NexusNotFoundException("Shipment not found.");
        if (isManual != true) throw new NexusValidationException("Cargo lines can only be added to a manual shipment.");

        var description = string.IsNullOrWhiteSpace(body.Description) ? null : body.Description.Trim();
        var packageCount = Math.Max(1, body.PackageCount ?? 1);
        var (length, width, height) = (body.Length, body.Width, body.Height);
        var volume = ComputeVolume(length, width, height);

        if (body.Weight <= 0) throw new NexusValidationException("Weight must be greater than 0.");

        await connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO log.ManualCargoItem (ShipmentID, Description, PackageCount, Weight, Length, Width, Height, Volume, CreatedBy)
            VALUES (@shipmentId, @description, @packageCount, @weight, @length, @width, @height, @volume, @createdBy)
            """, new { shipmentId, description, packageCount, weight = body.Weight, length, width, height, volume, createdBy = actor }, cancellationToken: ct));

        await RecalcManualShipmentTotalsAsync(connection, shipmentId, ct);
    }

    /// <summary>A null request field means "leave unchanged" — see UpdateManualCargoItemRequest's own doc comment for the one real capability lost (explicitly clearing a dimension to blank).</summary>
    internal static async Task UpdateAsync(INexusOperationsDb db, int cargoId, UpdateManualCargoItemRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var current = await connection.QuerySingleOrDefaultAsync<(long ShipmentId, string? Description, int PackageCount, decimal Weight, decimal? Length, decimal? Width, decimal? Height)?>(new CommandDefinition(
            "SELECT ShipmentID, Description, PackageCount, Weight, Length, Width, Height FROM log.ManualCargoItem WHERE CargoID = @cargoId", new { cargoId }, cancellationToken: ct));
        if (current is null) throw new NexusNotFoundException("Cargo line not found.");

        var description = body.Description is not null ? (string.IsNullOrWhiteSpace(body.Description) ? null : body.Description.Trim()) : current.Value.Description;
        var packageCount = body.PackageCount is not null ? Math.Max(1, body.PackageCount.Value) : current.Value.PackageCount;
        var weight = body.Weight ?? current.Value.Weight;
        var length = body.Length ?? current.Value.Length;
        var width = body.Width ?? current.Value.Width;
        var height = body.Height ?? current.Value.Height;
        var volume = ComputeVolume(length, width, height);

        if (weight <= 0) throw new NexusValidationException("Weight must be greater than 0.");

        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.ManualCargoItem SET Description = @description, PackageCount = @packageCount, Weight = @weight,
                Length = @length, Width = @width, Height = @height, Volume = @volume
            WHERE CargoID = @cargoId
            """, new { cargoId, description, packageCount, weight, length, width, height, volume }, cancellationToken: ct));

        await RecalcManualShipmentTotalsAsync(connection, current.Value.ShipmentId, ct);
    }

    internal static async Task DeleteAsync(INexusOperationsDb db, int cargoId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var shipmentId = await connection.QuerySingleOrDefaultAsync<long?>(new CommandDefinition(
            "SELECT ShipmentID FROM log.ManualCargoItem WHERE CargoID = @cargoId", new { cargoId }, cancellationToken: ct));
        if (shipmentId is null) throw new NexusNotFoundException("Cargo line not found.");

        await connection.ExecuteAsync(new CommandDefinition(
            "UPDATE log.ManualCargoItem SET Removed = 1 WHERE CargoID = @cargoId", new { cargoId }, cancellationToken: ct));

        await RecalcManualShipmentTotalsAsync(connection, shipmentId.Value, ct);
    }

    /// <summary>Volume in m3 from Length/Width/Height in cm — matches the Kuehne+Nagel cargoItem convention elsewhere in this app (dimensions entered in cm, /1,000,000 converts cm3 -> m3 directly).</summary>
    private static decimal? ComputeVolume(decimal? length, decimal? width, decimal? height) =>
        length is not null && width is not null && height is not null ? (length.Value * width.Value * height.Value) / 1_000_000m : null;

    private static async Task RecalcManualShipmentTotalsAsync(Microsoft.Data.SqlClient.SqlConnection connection, long shipmentId, CancellationToken ct)
    {
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.ShipmentMain SET
                grossWeight = t.totalWeight, netWeight = t.totalWeight, palletCount = t.totalPackages, shipmentVolume = t.totalVolume
            FROM log.ShipmentMain sm
            CROSS APPLY (
                SELECT ISNULL(SUM(Weight), 0) AS totalWeight, ISNULL(SUM(PackageCount), 0) AS totalPackages, ISNULL(SUM(Volume), 0) AS totalVolume
                FROM log.ManualCargoItem WHERE ShipmentID = sm.shipmentID AND Removed = 0
            ) t
            WHERE sm.shipmentID = @shipmentId
            """, new { shipmentId }, cancellationToken: ct));
    }

    // ── Create folder ─────────────────────────────────────────────────

    /// <summary>
    /// Ensures a shipment's customer/shipment export folders exist on
    /// disk. Node's own mkdirRecursiveSafe deliberately avoids
    /// fs.mkdir(path, {{recursive:true}}) due to a documented libuv bug on
    /// Windows (a mis-resolved long-path prefix past the drive root) —
    /// .NET's Directory.CreateDirectory is a distinct BCL implementation
    /// with no equivalent known issue, so this port uses it directly
    /// rather than reproducing Node's manual per-level mkdir loop; the
    /// underlying defensiveness (never trust one recursive native call to
    /// get every intermediate level right) doesn't need porting because
    /// the specific bug it worked around doesn't exist on this platform.
    /// </summary>
    internal static async Task<CreateShipmentFolderResult> CreateFolderAsync(INexusOperationsDb db, IOptions<LogisticsOptions> options, long shipmentId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var shipment = await ShipmentHelper.GetShipmentByIdAsync(connection, shipmentId, ct) ?? throw new NexusNotFoundException($"Shipment {shipmentId} not found.");

        var folder = ShipmentHelper.GetShipmentFolderInfo(shipment, options.Value);
        Directory.CreateDirectory(folder.ShipmentPath);

        return new CreateShipmentFolderResult(folder.ShipmentRef, folder.ShipmentPath);
    }
}
