using Dapper;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// MRP Analysis — Logistics Sub-phase 8b.1 (Trends) + 8b.5 (refresh-status;
/// the forecast/BOM-explosion routes themselves live in MrpForecastHelper).
/// Port of routes/mrpanalysis.js's GET /trends + /refresh-status + their
/// performancesql.js backing queries. Trends' year-on-year consumption/
/// goods-receipt figures are resolvable per vendor — consumption is
/// vendor-agnostic (SAP doesn't attribute usage to whichever vendor happened
/// to supply the material) so it's always returned unfiltered by vendor;
/// receipts are the vendor-resolvable series.
/// </summary>
internal static class MrpAnalysisHelper
{
    // Same ~5-year window runMrpHistoryRefresh bounds the goods-receipt SAP pull to (8b.5) —
    // belt-and-braces read-side floor here too, so a stray old row can't resurface years of
    // "order quantity received" with no matching consumption figure next to it.
    private static int EarliestMrpHistoryYear() => DateTime.UtcNow.Year - 4;

    /// <summary>
    /// Just the single latest run (or null) — unlike performance.js's multi-dataset "no false
    /// confidence" refresh-status routes (8b.1), this dataset is a single named row, so there's
    /// no failures-array/lastRefreshUtc shape to compute here. runMrpHistoryRefresh itself (the
    /// real SAP-pulling sync job) is deferred to 8b.6's refresh-orchestration slice.
    /// </summary>
    internal static async Task<MrpRefreshStatusRow?> GetRefreshStatusAsync(INexusDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleOrDefaultAsync<MrpRefreshStatusRow?>(new CommandDefinition("""
            SELECT TOP 1 Status, CompletedAtUtc, ErrorMessage, RunId
            FROM dbo.RefreshLog
            WHERE DatasetName = 'MrpAnalysisHistory'
            ORDER BY RunId DESC
            """, cancellationToken: ct));
    }

    internal static async Task<MrpTrendsResult> GetTrendsAsync(INexusOperationsDb db, IReadOnlyList<string>? materials, long? vendorId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        // A vendor filter with no explicit material search should only show materials that vendor
        // actually has ordering (goods-receipt) history for — not every ROH material with a blank
        // column for a vendor that never supplied it. Resolving this narrows what consumption asks
        // for too, so it has to happen before the (otherwise parallel) fetch below.
        if (vendorId.HasValue && (materials is null || materials.Count == 0))
        {
            var vendorMaterials = await ListVendorMaterialsFromReceiptHistoryAsync(connection, vendorId.Value, ct);
            if (vendorMaterials.Count == 0) return new MrpTrendsResult([], []);
            materials = vendorMaterials;
        }

        var consumption = await GetConsumptionByYearAsync(connection, materials, ct);
        var receipts = await GetReceiptHistoryByVendorAsync(connection, materials, vendorId, ct);

        return new MrpTrendsResult(consumption, receipts);
    }

    /// <summary>Standalone wrapper for callers with no already-open connection — Sub-phase 8b.5's percentage-forecast preview, which needs only this one query.</summary>
    internal static async Task<IReadOnlyList<ConsumptionByYearRow>> GetConsumptionByYearAsync(INexusOperationsDb db, IReadOnlyList<string>? materials, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await GetConsumptionByYearAsync(connection, materials, ct);
    }

    internal static async Task<IReadOnlyList<ConsumptionByYearRow>> GetConsumptionByYearAsync(System.Data.IDbConnection connection, IReadOnlyList<string>? materials, CancellationToken ct)
    {
        var whereSql = materials is { Count: > 0 } ? "AND h.Material IN @materials" : "";
        var rows = await connection.QueryAsync<ConsumptionByYearRow>(new CommandDefinition($"""
            SELECT h.Material, t.MaterialText, h.FiscalYear, h.ConsumedQty
            FROM log.MaterialConsumptionHistory h
            JOIN log.TurnsValClassSnapshot t ON t.Material = h.Material AND t.MaterialType = 'ROH'
            WHERE 1 = 1 {whereSql}
            ORDER BY h.Material, h.FiscalYear
            """, new { materials }, cancellationToken: ct));
        return rows.AsList();
    }

    private static async Task<IReadOnlyList<ReceiptHistoryByVendorRow>> GetReceiptHistoryByVendorAsync(System.Data.IDbConnection connection, IReadOnlyList<string>? materials, long? vendorId, CancellationToken ct)
    {
        var conditions = new List<string>();
        if (materials is { Count: > 0 }) conditions.Add("h.Material IN @materials");
        if (vendorId.HasValue) conditions.Add("h.VendorId = @vendorId");
        conditions.Add("h.FiscalYear >= @earliestYear");

        var rows = await connection.QueryAsync<ReceiptHistoryByVendorRow>(new CommandDefinition($"""
            SELECT h.Material, t.MaterialText, h.VendorId, v.VendorName, h.SapVendorNumber, h.FiscalYear, h.ReceivedQty, h.Uom
            FROM log.MaterialReceiptHistory h
            LEFT JOIN log.Vendor v ON v.VendorId = h.VendorId
            JOIN log.TurnsValClassSnapshot t ON t.Material = h.Material AND t.MaterialType = 'ROH'
            WHERE {string.Join(" AND ", conditions)}
            ORDER BY h.Material, h.FiscalYear, v.VendorName
            """, new { materials, vendorId, earliestYear = EarliestMrpHistoryYear() }, cancellationToken: ct));
        return rows.AsList();
    }

    // Distinct materials a vendor actually has goods-receipt history for — used by GetTrendsAsync
    // so picking a vendor with no material filter shows only what that vendor has actually
    // supplied, not every ROH material with a blank column for it.
    private static async Task<IReadOnlyList<string>> ListVendorMaterialsFromReceiptHistoryAsync(System.Data.IDbConnection connection, long vendorId, CancellationToken ct)
    {
        var materials = await connection.QueryAsync<string>(new CommandDefinition("""
            SELECT DISTINCT h.Material
            FROM log.MaterialReceiptHistory h
            JOIN log.TurnsValClassSnapshot t ON t.Material = h.Material AND t.MaterialType = 'ROH'
            WHERE h.VendorId = @vendorId AND h.FiscalYear >= @earliestYear
            """, new { vendorId, earliestYear = EarliestMrpHistoryYear() }, cancellationToken: ct));
        return materials.AsList();
    }
}
