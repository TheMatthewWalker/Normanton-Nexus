using Dapper;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Warehouse;

/// <summary>
/// Material Request Units (log.MaterialRequestUnits) — port of the two
/// read-only routes/materialRequestUnits.js endpoints Staging Post's
/// request form actually needs (the unit dropdown lookup and the
/// server-side conversion Staging Post's own create-request validates
/// against). The full admin CRUD surface (add/edit/delete/bulk-upload,
/// all LOG_ADMIN-gated) is Node's own separate "Material Request Units"
/// tile under Logistics, not Warehouse — deferred to Phase 8d (Logistics
/// reference data) rather than built here just to support this one
/// dependency, same "port only what the current slice needs, defer the
/// rest to the phase that actually owns it" precedent as
/// RedrumReversalHelper reusing Production's already-shipped Mf41Request.
/// </summary>
internal static class MaterialRequestUnitsHelper
{
    internal static async Task<IReadOnlyList<MaterialRequestUnitRow>> GetByMaterialAsync(INexusOperationsDb db, string material, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<MaterialRequestUnitRow>(new CommandDefinition("""
            SELECT RequestUnitId, Material, Unit, ConversionQty
            FROM log.MaterialRequestUnits
            WHERE Material = @material
            ORDER BY Unit
            """, new { material }, cancellationToken: ct));
        return rows.AsList();
    }

    /// <summary>Throws InvalidOperationException naming both material and unit when the pair isn't configured — mirrors Node's own getConversionQty exactly, including its error message, so Staging Post's create-request 400 response text matches.</summary>
    internal static async Task<decimal> GetConversionQtyAsync(INexusOperationsDb db, string material, string unit, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var qty = await connection.QuerySingleOrDefaultAsync<decimal?>(new CommandDefinition("""
            SELECT ConversionQty FROM log.MaterialRequestUnits WHERE Material = @material AND Unit = @unit
            """, new { material, unit }, cancellationToken: ct));

        if (qty is null)
            throw new InvalidOperationException($"No conversion configured for {unit} of {material}. Add one on the Material Request Units admin tile before this unit can be requested.");

        return qty.Value;
    }
}
