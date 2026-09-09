using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Material Request Units (log.MaterialRequestUnits) — port of
/// routes/materialRequestUnits.js in full. Lets Production raise a Staging
/// Post request in a unit they actually think in on the floor ("1 spool",
/// "3 tubs") instead of a raw KG figure — each row is one
/// (Material, Unit) -> ConversionQty (KG per 1 of that unit) mapping,
/// maintained via this Logistics admin tile. GetByMaterialAsync/
/// GetConversionQtyAsync were already built minimally in Warehouse
/// Sub-phase 7d (Staging Post's own dependency on this table, before this
/// department's own phase had started) — moved here now that Logistics
/// owns the full tile, with the CRUD Node's admin UI needs added alongside.
/// </summary>
internal static class MaterialRequestUnitsHelper
{
    internal static async Task<IReadOnlyList<MaterialRequestUnitRow>> ListAllAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<MaterialRequestUnitRow>(new CommandDefinition("""
            SELECT RequestUnitId, Material, Unit, ConversionQty, CreatedBy, CreatedAtUtc, UpdatedAtUtc
            FROM log.MaterialRequestUnits ORDER BY Material, Unit
            """, cancellationToken: ct));
        return rows.AsList();
    }

    /// <summary>Staging Post's request form calls this once a material is picked, to populate (or hide) the unit dropdown — cheap enough to call per-pick rather than caching the full table client-side.</summary>
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

    /// <summary>Called directly (in-process, not over HTTP) by Staging Post's own create-request flow — the conversion is computed server-side from this table rather than trusting a client-supplied KG figure. Throws naming both material and unit when the pair isn't configured, mirroring Node's own getConversionQty exactly, including its error message.</summary>
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

    internal static async Task<int> CreateAsync(INexusOperationsDb db, CreateMaterialRequestUnitRequest body, string? actor, CancellationToken ct)
    {
        Validate(body);
        using var connection = await db.CreateConnectionAsync(ct);
        try
        {
            return await connection.QuerySingleAsync<int>(new CommandDefinition("""
                INSERT INTO log.MaterialRequestUnits (Material, Unit, ConversionQty, CreatedBy)
                OUTPUT INSERTED.RequestUnitId
                VALUES (@material, @unit, @conversionQty, @createdBy)
                """, new { material = body.Material.Trim(), unit = body.Unit.Trim(), body.ConversionQty, createdBy = actor }, cancellationToken: ct));
        }
        catch (Exception ex) when (IsDuplicateKeyViolation(ex))
        {
            throw new NexusValidationException($"A conversion for {body.Material} / {body.Unit} already exists.");
        }
    }

    internal static async Task UpdateAsync(INexusOperationsDb db, int requestUnitId, CreateMaterialRequestUnitRequest body, CancellationToken ct)
    {
        Validate(body);
        using var connection = await db.CreateConnectionAsync(ct);
        try
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE log.MaterialRequestUnits SET
                    Material = @material, Unit = @unit, ConversionQty = @conversionQty, UpdatedAtUtc = GETUTCDATE()
                WHERE RequestUnitId = @requestUnitId
                """, new { requestUnitId, material = body.Material.Trim(), unit = body.Unit.Trim(), body.ConversionQty }, cancellationToken: ct));
        }
        catch (Exception ex) when (IsDuplicateKeyViolation(ex))
        {
            throw new NexusValidationException($"A conversion for {body.Material} / {body.Unit} already exists.");
        }
    }

    internal static async Task DeleteAsync(INexusOperationsDb db, int requestUnitId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "DELETE FROM log.MaterialRequestUnits WHERE RequestUnitId = @requestUnitId", new { requestUnitId }, cancellationToken: ct));
    }

    /// <summary>Upsert, not insert-only — re-uploading a CSV to correct a conversion figure is the expected workflow. Row-level failures are collected rather than aborting the whole batch.</summary>
    internal static async Task<BulkImportMaterialRequestUnitsResult> BulkImportAsync(INexusOperationsDb db, List<MaterialRequestUnitImportRow> records, string? actor, CancellationToken ct)
    {
        if (records.Count == 0)
            throw new NexusValidationException("records array is required and must not be empty.");

        using var connection = await db.CreateConnectionAsync(ct);
        int inserted = 0, updated = 0;
        var errors = new List<MaterialRequestUnitImportError>();

        foreach (var r in records)
        {
            if (string.IsNullOrWhiteSpace(r.Material) || string.IsNullOrWhiteSpace(r.Unit) || !(r.ConversionQty > 0))
            {
                errors.Add(new MaterialRequestUnitImportError(r.Material, r.Unit, "material, unit and a positive conversionQty are required."));
                continue;
            }
            try
            {
                var action = await connection.QuerySingleAsync<string>(new CommandDefinition("""
                    MERGE log.MaterialRequestUnits AS target
                    USING (SELECT @material AS Material, @unit AS Unit) AS src
                        ON target.Material = src.Material AND target.Unit = src.Unit
                    WHEN MATCHED THEN
                        UPDATE SET ConversionQty = @conversionQty, UpdatedAtUtc = GETUTCDATE()
                    WHEN NOT MATCHED THEN
                        INSERT (Material, Unit, ConversionQty, CreatedBy)
                        VALUES (@material, @unit, @conversionQty, @createdBy)
                    OUTPUT $action AS Action;
                    """, new { material = r.Material.Trim(), unit = r.Unit.Trim(), r.ConversionQty, createdBy = actor }, cancellationToken: ct));
                if (action == "INSERT") inserted++; else updated++;
            }
            catch (Exception ex)
            {
                errors.Add(new MaterialRequestUnitImportError(r.Material, r.Unit, ex.Message));
            }
        }

        return new BulkImportMaterialRequestUnitsResult(inserted, updated, errors);
    }

    private static void Validate(CreateMaterialRequestUnitRequest body)
    {
        if (string.IsNullOrWhiteSpace(body.Material))
            throw new NexusValidationException("material is required.");
        if (string.IsNullOrWhiteSpace(body.Unit))
            throw new NexusValidationException("unit is required.");
        if (!(body.ConversionQty > 0))
            throw new NexusValidationException("conversionQty must be greater than zero.");
    }

    private static bool IsDuplicateKeyViolation(Exception ex) =>
        ex.Message.Contains("UQ_MaterialRequestUnits_Material_Unit", StringComparison.OrdinalIgnoreCase);
}
