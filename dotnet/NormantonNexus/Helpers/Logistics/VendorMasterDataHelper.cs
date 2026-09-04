using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Vendor master data + demand adjustments (MRP Phase 2) — Logistics
/// Sub-phase 8b.2. Port of routes/performance.js's /vendors, /vendors/:id/materials
/// and /demand-adjustments routes + their performancesql.js backing queries.
/// Manually-maintained, not sourced from SAP — see log.Vendor/log.VendorMaterial/
/// log.DemandAdjustment's own migration comments.
/// </summary>
internal static class VendorMasterDataHelper
{
    // ── Vendors (log.Vendor) ─────────────────────────────────────────────

    internal static async Task<IReadOnlyList<VendorRow>> ListVendorsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<VendorRow>(new CommandDefinition("""
            SELECT
              v.VendorId, v.VendorName, v.SapVendorNumber, v.Currency, v.Incoterms, v.OrderMoqQty, v.OrderMaxQty, v.OrderMoqUom,
              v.DefaultLeadTimeDays, v.TransitTimeDays, v.Notes, v.CreatedAtUtc, v.UpdatedAtUtc,
              (SELECT COUNT(*) FROM log.VendorMaterial vm WHERE vm.VendorId = v.VendorId) AS MaterialCount
            FROM log.Vendor v
            ORDER BY v.VendorName
            """, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<long> CreateVendorAsync(INexusOperationsDb db, UpsertVendorRequest body, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.VendorName)) throw new NexusValidationException("vendorName is required.");

        using var connection = await db.CreateConnectionAsync(ct);
        try
        {
            return await connection.QuerySingleAsync<long>(new CommandDefinition("""
                INSERT INTO log.Vendor (VendorName, SapVendorNumber, Currency, Incoterms, OrderMoqQty, OrderMaxQty, OrderMoqUom, DefaultLeadTimeDays, TransitTimeDays, Notes)
                OUTPUT INSERTED.VendorId
                VALUES (@VendorName, @SapVendorNumber, @Currency, @Incoterms, @OrderMoqQty, @OrderMaxQty, @OrderMoqUom, @DefaultLeadTimeDays, @TransitTimeDays, @Notes)
                """, body, cancellationToken: ct));
        }
        catch (Exception ex) when (ex.Message.Contains("UQ_Vendor_Name", StringComparison.OrdinalIgnoreCase))
        {
            // UQ_Vendor_Name violation reads as a generic SQL error otherwise — surface it plainly
            // since this is the one thing a user is likely to hit.
            throw new NexusValidationException($"A vendor named \"{body.VendorName}\" already exists.");
        }
    }

    internal static async Task UpdateVendorAsync(INexusOperationsDb db, long vendorId, UpsertVendorRequest body, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.VendorName)) throw new NexusValidationException("vendorName is required.");

        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.Vendor SET
              VendorName = @VendorName, SapVendorNumber = @SapVendorNumber, Currency = @Currency, Incoterms = @Incoterms,
              OrderMoqQty = @OrderMoqQty, OrderMaxQty = @OrderMaxQty, OrderMoqUom = @OrderMoqUom,
              DefaultLeadTimeDays = @DefaultLeadTimeDays, TransitTimeDays = @TransitTimeDays, Notes = @Notes,
              UpdatedAtUtc = GETUTCDATE()
            WHERE VendorId = @vendorId
            """, new { vendorId, body.VendorName, body.SapVendorNumber, body.Currency, body.Incoterms, body.OrderMoqQty, body.OrderMaxQty, body.OrderMoqUom, body.DefaultLeadTimeDays, body.TransitTimeDays, body.Notes }, cancellationToken: ct));
    }

    /// <summary>
    /// Deletes the vendor's material assignments first — SQL Server 2005 would otherwise reject
    /// the delete outright on the FK_VendorMaterial_Vendor constraint. Two explicit statements
    /// (not ON DELETE CASCADE) so this is visible/auditable in one place, matching this app's
    /// "no transactions, explicit steps" convention elsewhere.
    /// </summary>
    internal static async Task DeleteVendorAsync(INexusOperationsDb db, long vendorId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("DELETE FROM log.VendorMaterial WHERE VendorId = @vendorId", new { vendorId }, cancellationToken: ct));
        await connection.ExecuteAsync(new CommandDefinition("DELETE FROM log.Vendor WHERE VendorId = @vendorId", new { vendorId }, cancellationToken: ct));
    }

    // ── Vendor materials (log.VendorMaterial) ────────────────────────────

    /// <summary>LEFT JOIN, not INNER — a material can be assigned to a vendor before/without ever having synced into TurnsValClassSnapshot, and should still show up here rather than vanish.</summary>
    internal static async Task<IReadOnlyList<VendorMaterialAssignmentRow>> ListVendorMaterialsAsync(INexusOperationsDb db, long vendorId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<VendorMaterialAssignmentRow>(new CommandDefinition("""
            SELECT
              vm.VendorMaterialId, vm.VendorId, vm.Material, vm.MaterialMoqQty, vm.MaterialMaxQty,
              vm.LeadTimeDaysOverride, vm.MinSafetyStockQty, vm.ScheduleAgreement, vm.ScheduleAgreementItem, vm.SourceHint,
              t.MaterialText, t.MrpController, t.PlannedDeliveryTime AS SapLeadTimeDays, t.SafetyStock AS SapSafetyStock
            FROM log.VendorMaterial vm
            LEFT JOIN log.TurnsValClassSnapshot t ON t.Material = vm.Material
            WHERE vm.VendorId = @vendorId
            ORDER BY vm.Material
            """, new { vendorId }, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<long> AddVendorMaterialAsync(INexusOperationsDb db, long vendorId, AddVendorMaterialRequest body, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.Material)) throw new NexusValidationException("material is required.");

        using var connection = await db.CreateConnectionAsync(ct);
        try
        {
            return await connection.QuerySingleAsync<long>(new CommandDefinition("""
                INSERT INTO log.VendorMaterial (VendorId, Material, MaterialMoqQty, MaterialMaxQty, LeadTimeDaysOverride, MinSafetyStockQty, ScheduleAgreement, ScheduleAgreementItem, SourceHint)
                OUTPUT INSERTED.VendorMaterialId
                VALUES (@vendorId, @Material, @MaterialMoqQty, @MaterialMaxQty, @LeadTimeDaysOverride, @MinSafetyStockQty, @ScheduleAgreement, @ScheduleAgreementItem, @SourceHint)
                """, new { vendorId, body.Material, body.MaterialMoqQty, body.MaterialMaxQty, body.LeadTimeDaysOverride, body.MinSafetyStockQty, body.ScheduleAgreement, body.ScheduleAgreementItem, body.SourceHint }, cancellationToken: ct));
        }
        catch (Exception ex) when (ex.Message.Contains("UQ_VendorMaterial", StringComparison.OrdinalIgnoreCase))
        {
            throw new NexusValidationException($"{body.Material} is already assigned to this vendor.");
        }
    }

    internal static async Task UpdateVendorMaterialAsync(INexusOperationsDb db, long vendorMaterialId, UpdateVendorMaterialRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.VendorMaterial SET
              MaterialMoqQty = @MaterialMoqQty, MaterialMaxQty = @MaterialMaxQty,
              LeadTimeDaysOverride = @LeadTimeDaysOverride,
              MinSafetyStockQty = @MinSafetyStockQty,
              ScheduleAgreement = @ScheduleAgreement, ScheduleAgreementItem = @ScheduleAgreementItem,
              UpdatedAtUtc = GETUTCDATE()
            WHERE VendorMaterialId = @vendorMaterialId
            """, new { vendorMaterialId, body.MaterialMoqQty, body.MaterialMaxQty, body.LeadTimeDaysOverride, body.MinSafetyStockQty, body.ScheduleAgreement, body.ScheduleAgreementItem }, cancellationToken: ct));
    }

    internal static async Task DeleteVendorMaterialAsync(INexusOperationsDb db, long vendorMaterialId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("DELETE FROM log.VendorMaterial WHERE VendorMaterialId = @vendorMaterialId", new { vendorMaterialId }, cancellationToken: ct));
    }

    // ── Demand adjustments (log.DemandAdjustment) ────────────────────────

    /// <summary>The admin table's list view — same rows as the forecast-facing raw read, with the material's description joined in.</summary>
    internal static async Task<IReadOnlyList<DemandAdjustmentRow>> ListDemandAdjustmentsForAdminAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<DemandAdjustmentRow>(new CommandDefinition("""
            SELECT
              d.AdjustmentId, d.Material, d.StartDate, d.EndDate, d.UsagePercent, d.Reason,
              d.CreatedBy, d.CreatedAtUtc, d.UpdatedAtUtc, t.MaterialText
            FROM log.DemandAdjustment d
            LEFT JOIN log.TurnsValClassSnapshot t ON t.Material = d.Material
            ORDER BY d.Material, d.StartDate
            """, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<long> CreateDemandAdjustmentAsync(INexusOperationsDb db, UpsertDemandAdjustmentRequest body, string? createdBy, CancellationToken ct)
    {
        ValidateDemandAdjustment(body);
        using var connection = await db.CreateConnectionAsync(ct);

        var overlap = await FindOverlappingAdjustmentAsync(connection, body.Material, body.StartDate, body.EndDate, excludeId: null, ct);
        if (overlap is not null)
            throw new NexusValidationException($"This material already has an adjustment covering {FormatAdjustmentRange(overlap)} — edit or delete that one instead of creating an overlapping second adjustment.");

        return await connection.QuerySingleAsync<long>(new CommandDefinition("""
            INSERT INTO log.DemandAdjustment (Material, StartDate, EndDate, UsagePercent, Reason, CreatedBy)
            OUTPUT INSERTED.AdjustmentId
            VALUES (@Material, @StartDate, @EndDate, @UsagePercent, @Reason, @createdBy)
            """, new { body.Material, body.StartDate, body.EndDate, body.UsagePercent, body.Reason, createdBy }, cancellationToken: ct));
    }

    internal static async Task UpdateDemandAdjustmentAsync(INexusOperationsDb db, long adjustmentId, UpsertDemandAdjustmentRequest body, CancellationToken ct)
    {
        ValidateDemandAdjustment(body);
        using var connection = await db.CreateConnectionAsync(ct);

        var overlap = await FindOverlappingAdjustmentAsync(connection, body.Material, body.StartDate, body.EndDate, excludeId: adjustmentId, ct);
        if (overlap is not null)
            throw new NexusValidationException($"This material already has another adjustment covering {FormatAdjustmentRange(overlap)} — edit or delete that one instead of creating an overlapping second adjustment.");

        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.DemandAdjustment SET
              Material = @Material, StartDate = @StartDate, EndDate = @EndDate,
              UsagePercent = @UsagePercent, Reason = @Reason, UpdatedAtUtc = GETUTCDATE()
            WHERE AdjustmentId = @adjustmentId
            """, new { adjustmentId, body.Material, body.StartDate, body.EndDate, body.UsagePercent, body.Reason }, cancellationToken: ct));
    }

    internal static async Task DeleteDemandAdjustmentAsync(INexusOperationsDb db, long adjustmentId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("DELETE FROM log.DemandAdjustment WHERE AdjustmentId = @adjustmentId", new { adjustmentId }, cancellationToken: ct));
    }

    private static void ValidateDemandAdjustment(UpsertDemandAdjustmentRequest body)
    {
        if (string.IsNullOrWhiteSpace(body.Material)) throw new NexusValidationException("material is required.");
        if (body.UsagePercent is null || body.UsagePercent < 0) throw new NexusValidationException("usagePercent is required and cannot be negative.");
    }

    /// <summary>
    /// Two ranges overlap unless one entirely ends (with a real EndDate) before the other entirely
    /// starts (with a real StartDate) — a null bound on either side means it can never be true in
    /// that direction (an unbounded side never "ends before"/"starts after" anything). excludeId
    /// lets an update check against every OTHER row for the same material without tripping over itself.
    /// </summary>
    private static async Task<OverlappingAdjustment?> FindOverlappingAdjustmentAsync(System.Data.IDbConnection connection, string material, DateTime? startDate, DateTime? endDate, long? excludeId, CancellationToken ct)
    {
        var excludeSql = excludeId.HasValue ? "AND AdjustmentId <> @excludeId" : "";
        return await connection.QuerySingleOrDefaultAsync<OverlappingAdjustment?>(new CommandDefinition($"""
            SELECT TOP 1 AdjustmentId, StartDate, EndDate FROM log.DemandAdjustment
            WHERE Material = @material
              {excludeSql}
              AND NOT (EndDate IS NOT NULL AND @startDate IS NOT NULL AND EndDate < @startDate)
              AND NOT (StartDate IS NOT NULL AND @endDate IS NOT NULL AND StartDate > @endDate)
            """, new { material, startDate, endDate, excludeId }, cancellationToken: ct));
    }

    private static string FormatAdjustmentRange(OverlappingAdjustment row)
    {
        var start = row.StartDate?.ToString("yyyy-MM-dd") ?? "the beginning";
        var end = row.EndDate?.ToString("yyyy-MM-dd") ?? "indefinitely";
        return $"{start} to {end}";
    }
}
