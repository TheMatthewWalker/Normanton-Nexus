using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Customs Report admin/reference data (log.CustomsVatNumberOverrides,
/// log.CustomsHsCodeDescriptions) — Logistics Sub-phase 8c.1, port of
/// routes/customsreportadmin.js in full. Both tables already exist in
/// NexusOperations (migrated independently via
/// migrations/nexus_operations/20260811090000_add_customs_report_tables.cjs)
/// — nothing to add via this project's own EF migrations, same as every
/// other pre-existing `log.*` table this migration reads/writes.
///
/// LookupVatOverrideAsync/LookupHsDescriptionAsync are called in-process by
/// the report-generation helper (CustomsReportHelper, Sub-phase 8c.2) — same
/// role Node's own exported lookupVatOverride/lookupHsDescription functions
/// play for customsreport.js, just as a direct C# method call instead of an
/// ES module import.
/// </summary>
internal static class CustomsAdminHelper
{
    // ── VAT number overrides ─────────────────────────────────────────

    internal static async Task<IReadOnlyList<CustomsVatOverrideRow>> ListVatOverridesAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<CustomsVatOverrideRow>(new CommandDefinition("""
            SELECT OverrideId, ConsigneeCode, VatNumber, Notes, CreatedAtUtc, UpdatedAtUtc
            FROM log.CustomsVatNumberOverrides
            ORDER BY ConsigneeCode
            """, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<int> CreateVatOverrideAsync(INexusOperationsDb db, CreateCustomsVatOverrideRequest body, string? actor, CancellationToken ct)
    {
        var (consigneeCode, vatNumber) = ValidateVatOverride(body);
        using var connection = await db.CreateConnectionAsync(ct);
        try
        {
            return await connection.QuerySingleAsync<int>(new CommandDefinition("""
                INSERT INTO log.CustomsVatNumberOverrides (ConsigneeCode, VatNumber, Notes, CreatedBy)
                OUTPUT INSERTED.OverrideId
                VALUES (@consigneeCode, @vatNumber, @notes, @createdBy)
                """, new { consigneeCode, vatNumber, notes = NullIfBlank(body.Notes), createdBy = actor }, cancellationToken: ct));
        }
        catch (Exception ex) when (IsVatOverrideDuplicate(ex))
        {
            throw new NexusValidationException($"A VAT override for consignee {body.ConsigneeCode} already exists.");
        }
    }

    internal static async Task UpdateVatOverrideAsync(INexusOperationsDb db, int overrideId, CreateCustomsVatOverrideRequest body, CancellationToken ct)
    {
        var (consigneeCode, vatNumber) = ValidateVatOverride(body);
        using var connection = await db.CreateConnectionAsync(ct);
        try
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE log.CustomsVatNumberOverrides SET
                    ConsigneeCode = @consigneeCode, VatNumber = @vatNumber, Notes = @notes, UpdatedAtUtc = GETUTCDATE()
                WHERE OverrideId = @overrideId
                """, new { overrideId, consigneeCode, vatNumber, notes = NullIfBlank(body.Notes) }, cancellationToken: ct));
        }
        catch (Exception ex) when (IsVatOverrideDuplicate(ex))
        {
            throw new NexusValidationException($"A VAT override for consignee {body.ConsigneeCode} already exists.");
        }
    }

    internal static async Task DeleteVatOverrideAsync(INexusOperationsDb db, int overrideId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "DELETE FROM log.CustomsVatNumberOverrides WHERE OverrideId = @overrideId", new { overrideId }, cancellationToken: ct));
    }

    /// <summary>Never throws — a missing entry is a normal, expected outcome for the report (see CustomsReportHelper), not an error.</summary>
    internal static async Task<string?> LookupVatOverrideAsync(INexusOperationsDb db, string? consigneeCode, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(consigneeCode)) return null;
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "SELECT VatNumber FROM log.CustomsVatNumberOverrides WHERE ConsigneeCode = @consigneeCode",
            new { consigneeCode = consigneeCode.Trim() }, cancellationToken: ct));
    }

    // ── HS / commodity code descriptions ─────────────────────────────

    internal static async Task<IReadOnlyList<CustomsHsDescriptionRow>> ListHsDescriptionsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<CustomsHsDescriptionRow>(new CommandDefinition("""
            SELECT HsCodeId, CommodityCode, Description, CreatedAtUtc, UpdatedAtUtc
            FROM log.CustomsHsCodeDescriptions
            ORDER BY CommodityCode
            """, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<int> CreateHsDescriptionAsync(INexusOperationsDb db, CreateCustomsHsDescriptionRequest body, string? actor, CancellationToken ct)
    {
        var (commodityCode, description) = ValidateHsDescription(body);
        using var connection = await db.CreateConnectionAsync(ct);
        try
        {
            return await connection.QuerySingleAsync<int>(new CommandDefinition("""
                INSERT INTO log.CustomsHsCodeDescriptions (CommodityCode, Description, CreatedBy)
                OUTPUT INSERTED.HsCodeId
                VALUES (@commodityCode, @description, @createdBy)
                """, new { commodityCode, description, createdBy = actor }, cancellationToken: ct));
        }
        catch (Exception ex) when (IsHsDescriptionDuplicate(ex))
        {
            throw new NexusValidationException($"A description for commodity code {body.CommodityCode} already exists.");
        }
    }

    internal static async Task UpdateHsDescriptionAsync(INexusOperationsDb db, int hsCodeId, CreateCustomsHsDescriptionRequest body, CancellationToken ct)
    {
        var (commodityCode, description) = ValidateHsDescription(body);
        using var connection = await db.CreateConnectionAsync(ct);
        try
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE log.CustomsHsCodeDescriptions SET
                    CommodityCode = @commodityCode, Description = @description, UpdatedAtUtc = GETUTCDATE()
                WHERE HsCodeId = @hsCodeId
                """, new { hsCodeId, commodityCode, description }, cancellationToken: ct));
        }
        catch (Exception ex) when (IsHsDescriptionDuplicate(ex))
        {
            throw new NexusValidationException($"A description for commodity code {body.CommodityCode} already exists.");
        }
    }

    internal static async Task DeleteHsDescriptionAsync(INexusOperationsDb db, int hsCodeId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "DELETE FROM log.CustomsHsCodeDescriptions WHERE HsCodeId = @hsCodeId", new { hsCodeId }, cancellationToken: ct));
    }

    /// <summary>Never throws — see LookupVatOverrideAsync.</summary>
    internal static async Task<string?> LookupHsDescriptionAsync(INexusOperationsDb db, string? commodityCode, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(commodityCode)) return null;
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "SELECT Description FROM log.CustomsHsCodeDescriptions WHERE CommodityCode = @commodityCode",
            new { commodityCode = commodityCode.Trim() }, cancellationToken: ct));
    }

    // ── Validation ────────────────────────────────────────────────────

    private static (string ConsigneeCode, string VatNumber) ValidateVatOverride(CreateCustomsVatOverrideRequest body)
    {
        if (string.IsNullOrWhiteSpace(body.ConsigneeCode))
            throw new NexusValidationException("consigneeCode is required.");
        if (string.IsNullOrWhiteSpace(body.VatNumber))
            throw new NexusValidationException("vatNumber is required.");
        return (body.ConsigneeCode.Trim(), body.VatNumber.Trim());
    }

    private static (string CommodityCode, string Description) ValidateHsDescription(CreateCustomsHsDescriptionRequest body)
    {
        if (string.IsNullOrWhiteSpace(body.CommodityCode))
            throw new NexusValidationException("commodityCode is required.");
        if (string.IsNullOrWhiteSpace(body.Description))
            throw new NexusValidationException("description is required.");
        return (body.CommodityCode.Trim(), body.Description.Trim());
    }

    private static string? NullIfBlank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s;

    private static bool IsVatOverrideDuplicate(Exception ex) =>
        ex.Message.Contains("UQ_CustomsVatNumberOverrides_Consignee", StringComparison.OrdinalIgnoreCase);

    private static bool IsHsDescriptionDuplicate(Exception ex) =>
        ex.Message.Contains("UQ_CustomsHsCodeDescriptions_Code", StringComparison.OrdinalIgnoreCase);
}
