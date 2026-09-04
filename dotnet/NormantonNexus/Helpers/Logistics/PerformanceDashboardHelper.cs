using Dapper;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Logistics Sub-phase 8b.1 — the simplest read-only Purchasing/Performance
/// dashboard routes: refresh log/status (dbo.RefreshLog, Nexus database),
/// value/OTIF metrics and order-book summary/breakdown (log.DailyPerformance/
/// log.AgreementSnapshot, NexusOperations), and the Stock Value Overview
/// (Turns/Valuation Class) tile's read side (log.TurnsValClassSnapshot/
/// log.StockValuationHistory/log.ValuationClassCatalog). No SAP calls, no
/// writes — port of the corresponding GET routes in routes/performance.js
/// (see PerformanceController). Vendor/demand-adjustment/order-suggestion
/// CRUD and the forecast-driven /turns-valclass/history route are deferred
/// to 8b.2/8b.3, which build directly on ForecastMathHelper.
/// </summary>
internal static class PerformanceDashboardHelper
{
    private static readonly string[] RefreshStatusDatasets = ["Stock", "Agreements", "Invoicing", "Otif"];
    private static readonly string[] TurnsValClassRefreshStatusDatasets = ["TurnsValClass", "ValuationClasses"];

    // ── Refresh log / status (dbo.RefreshLog, Nexus) ────────────────────

    internal static async Task<IReadOnlyList<RefreshLogRow>> GetRefreshLogAsync(INexusDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<RefreshLogRow>(new CommandDefinition(
            "SELECT TOP 20 RunId, DatasetName, Status, CompletedAtUtc, ErrorMessage FROM dbo.RefreshLog ORDER BY RunId DESC", cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<RefreshStatusResult> GetRefreshStatusAsync(INexusDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<RefreshLogRow>(new CommandDefinition("""
            SELECT TOP 80 RunId, DatasetName, Status, CompletedAtUtc, ErrorMessage
            FROM dbo.RefreshLog
            WHERE DatasetName IN ('Stock', 'Agreements', 'Invoicing', 'Otif')
            ORDER BY RunId DESC
            """, cancellationToken: ct));
        return ShapeRefreshStatus(RefreshStatusDatasets, rows);
    }

    /// <summary>Same dbo.RefreshLog table and "no false confidence" pattern as GetRefreshStatusAsync, scoped to the daily job runTurnsValClassRefresh writes. Gated the same as /aggregates so Reports-only viewers can see it without needing LOG_MRP.</summary>
    internal static async Task<RefreshStatusResult> GetTurnsValClassRefreshStatusAsync(INexusDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<RefreshLogRow>(new CommandDefinition("""
            SELECT TOP 40 RunId, DatasetName, Status, CompletedAtUtc, ErrorMessage
            FROM dbo.RefreshLog
            WHERE DatasetName IN ('TurnsValClass', 'ValuationClasses')
            ORDER BY RunId DESC
            """, cancellationToken: ct));
        return ShapeRefreshStatus(TurnsValClassRefreshStatusDatasets, rows);
    }

    /// <summary>
    /// Pure "latest run per dataset, no false confidence" shaping shared by
    /// GetRefreshStatusAsync/GetTurnsValClassRefreshStatusAsync — exposed
    /// internal for direct unit testing without a DB. lastRefreshUtc comes
    /// back null whenever ANY watched dataset isn't a clean Success (or has
    /// never run at all), rather than showing a stale "last refreshed" date
    /// that no longer reflects what's on screen.
    /// </summary>
    internal static RefreshStatusResult ShapeRefreshStatus(IReadOnlyList<string> datasets, IEnumerable<RefreshLogRow> rows)
    {
        var latest = new Dictionary<string, RefreshLogRow>();
        foreach (var row in rows)
        {
            if (row.DatasetName is not null && !latest.ContainsKey(row.DatasetName))
                latest[row.DatasetName] = row;
        }

        var data = datasets.Select(name =>
        {
            latest.TryGetValue(name, out var row);
            return new DatasetRefreshStatus(name, row?.Status ?? "Missing", row?.CompletedAtUtc, row?.ErrorMessage);
        }).ToList();

        var failures = data.Where(r => r.Status != "Success").ToList();
        var completedTimes = data.Where(r => r.Status == "Success" && r.CompletedAtUtc.HasValue).Select(r => r.CompletedAtUtc!.Value).ToList();

        DateTime? lastRefreshUtc = failures.Count > 0 || completedTimes.Count != datasets.Count ? null : completedTimes.Max();

        return new RefreshStatusResult(lastRefreshUtc, failures, data);
    }

    // ── Daily performance trend data (log.DailyPerformance, NexusOperations) ──
    // Never query the *Snapshot tables for trends — they only ever hold the latest pull.

    internal static async Task<IReadOnlyList<ValueMetricsDay>> GetValueMetricsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ValueMetricRawRow>(new CommandDefinition(
            "SELECT MetricDate, ValueStream, InvoicedValue, StockValue, PickedValue FROM log.DailyPerformance ORDER BY MetricDate", cancellationToken: ct));
        return ShapeValueMetrics(rows);
    }

    /// <summary>Pure pivot-by-date-then-ValueStream shaping — exposed internal for direct unit testing without a DB.</summary>
    internal static IReadOnlyList<ValueMetricsDay> ShapeValueMetrics(IEnumerable<ValueMetricRawRow> rows)
    {
        var order = new List<string>();
        var byDate = new Dictionary<string, Dictionary<string, ValueMetricStream>>();

        foreach (var row in rows)
        {
            var date = row.MetricDate.ToString("yyyy-MM-dd");
            if (!byDate.TryGetValue(date, out var streams))
            {
                streams = new Dictionary<string, ValueMetricStream>();
                byDate[date] = streams;
                order.Add(date);
            }

            streams.TryGetValue(row.ValueStream, out var existing);
            streams[row.ValueStream] = new ValueMetricStream(
                (existing?.Invoiced ?? 0m) + (row.InvoicedValue ?? 0m),
                (existing?.Stock ?? 0m) + (row.StockValue ?? 0m),
                (existing?.Picked ?? 0m) + (row.PickedValue ?? 0m));
        }

        return order.Select(date => new ValueMetricsDay(date, byDate[date])).ToList();
    }

    internal static async Task<IReadOnlyList<OtifMetricsDay>> GetOtifMetricsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<OtifMetricRawRow>(new CommandDefinition(
            "SELECT MetricDate, ValueStream, OtifOnTimeCount, OtifTotalCount FROM log.DailyPerformance ORDER BY MetricDate", cancellationToken: ct));
        return ShapeOtifMetrics(rows);
    }

    /// <summary>Pure pivot-by-date-then-ValueStream shaping with a running on-time ratio — exposed internal for direct unit testing without a DB.</summary>
    internal static IReadOnlyList<OtifMetricsDay> ShapeOtifMetrics(IEnumerable<OtifMetricRawRow> rows)
    {
        var order = new List<string>();
        var byDate = new Dictionary<string, Dictionary<string, (long OnTime, long Total)>>();

        foreach (var row in rows)
        {
            var date = row.MetricDate.ToString("yyyy-MM-dd");
            if (!byDate.TryGetValue(date, out var streams))
            {
                streams = [];
                byDate[date] = streams;
                order.Add(date);
            }

            streams.TryGetValue(row.ValueStream, out var existing);
            streams[row.ValueStream] = (existing.OnTime + (row.OtifOnTimeCount ?? 0), existing.Total + (row.OtifTotalCount ?? 0));
        }

        return order.Select(date => new OtifMetricsDay(date, byDate[date].ToDictionary(
            kv => kv.Key,
            kv => new OtifMetricStream(kv.Value.OnTime, kv.Value.Total, kv.Value.Total > 0 ? (decimal)kv.Value.OnTime / kv.Value.Total : 0m)))).ToList();
    }

    // ── Order book summary / breakdown (log.AgreementSnapshot, NexusOperations) ──

    internal static async Task<IReadOnlyList<OrderBookSummaryRow>> GetOrderBookSummaryAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        // LEFT JOIN .. IS NULL excludes consignment customers (see sql/migrate_consignment_customers.sql) —
        // kept consistent with GetOrderBookBreakdownAsync below so summary and export never disagree.
        var rows = await connection.QueryAsync<OrderBookSummaryRawRow>(new CommandDefinition("""
            SELECT
              DATEPART(YEAR, a.RequestDate)  AS Year,
              DATEPART(MONTH, a.RequestDate) AS Month,
              a.ValueStream,
              SUM(a.Amount) AS Orders,
              SUM(CASE WHEN a.OrderQty > 0 THEN a.DockStockAllocated * (a.Amount / a.OrderQty) ELSE 0 END) AS Stock,
              SUM(CASE WHEN a.OrderQty > 0 THEN a.PickedStockAllocated * (a.Amount / a.OrderQty) ELSE 0 END) AS Picked
            FROM log.AgreementSnapshot a
            LEFT JOIN log.ConsignmentCustomer cc ON cc.Customer = a.Customer
            WHERE a.RequestDate IS NOT NULL AND a.ValueStream IN ('PTFE','PV') AND cc.Customer IS NULL
            GROUP BY YEAR(a.RequestDate), MONTH(a.RequestDate), a.ValueStream
            ORDER BY YEAR(a.RequestDate), MONTH(a.RequestDate), a.ValueStream
            """, cancellationToken: ct));
        return rows.Select(r => new OrderBookSummaryRow(r.Year, r.Month, r.ValueStream, r.Orders ?? 0m, r.Stock ?? 0m, r.Picked ?? 0m)).ToList();
    }

    internal static async Task<IReadOnlyList<OrderBookBreakdownRow>> GetOrderBookBreakdownAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        // a.OriginalDoc AS ReferenceDocument, not the raw a.ReferenceDocument column — OriginalDoc is
        // the stable sales order number (resolved via VBFA when SAP is reporting a delivery number
        // instead — see performanceorderlink.js, 8b.6), so this keeps working even after a line is picked.
        var rows = await connection.QueryAsync<OrderBookBreakdownRawRow>(new CommandDefinition("""
            SELECT
              a.ValueStream, a.Customer, a.CustomerName, a.OriginalDoc AS ReferenceDocument, a.Material, a.MaterialText,
              CAST(CONVERT(VARCHAR(8), a.RequestDate, 112) AS DATETIME) AS RequestDate,
              SUM(a.OrderQty) AS OrderQty, SUM(a.Amount) AS OrderValue,
              SUM(a.DockStockAllocated) AS StockQty,
              SUM(CASE WHEN a.OrderQty > 0 THEN a.DockStockAllocated * (a.Amount / a.OrderQty) ELSE 0 END) AS StockValue,
              SUM(a.PickedStockAllocated) AS PickedQty,
              SUM(CASE WHEN a.OrderQty > 0 THEN a.PickedStockAllocated * (a.Amount / a.OrderQty) ELSE 0 END) AS PickedValue
            FROM log.AgreementSnapshot a
            LEFT JOIN log.ConsignmentCustomer cc ON cc.Customer = a.Customer
            WHERE a.RequestDate IS NOT NULL AND a.ValueStream IN ('PTFE','PV') AND cc.Customer IS NULL
            GROUP BY a.ValueStream, a.Customer, a.CustomerName, a.OriginalDoc, a.Material, a.MaterialText, CONVERT(VARCHAR(8), a.RequestDate, 112)
            ORDER BY CONVERT(VARCHAR(8), a.RequestDate, 112), a.CustomerName, a.OriginalDoc, a.MaterialText
            """, cancellationToken: ct));
        return rows.Select(r => new OrderBookBreakdownRow(
            r.ValueStream, r.Customer, r.CustomerName ?? r.Customer, r.ReferenceDocument, r.Material, r.MaterialText,
            r.RequestDate?.ToString("yyyy-MM-dd"),
            r.OrderQty ?? 0m, r.OrderValue ?? 0m, r.StockQty ?? 0m, r.StockValue ?? 0m, r.PickedQty ?? 0m, r.PickedValue ?? 0m)).ToList();
    }

    // ── Stock Value Overview / Turns & Valuation Class tile (NexusOperations) ──

    internal static async Task<IReadOnlyList<TurnsValClassRow>> GetTurnsValClassAsync(INexusOperationsDb db, TurnsValClassQuery query, CancellationToken ct)
    {
        var where = new List<string>();
        var parameters = new DynamicParameters();

        if (!string.IsNullOrEmpty(query.Plant)) { where.Add("Plant = @plant"); parameters.Add("plant", query.Plant); }
        if (!string.IsNullOrEmpty(query.ValuationClass)) { where.Add("ValuationClass = @valuationClass"); parameters.Add("valuationClass", query.ValuationClass); }
        if (!string.IsNullOrEmpty(query.MrpController)) { where.Add("MrpController = @mrpController"); parameters.Add("mrpController", query.MrpController); }
        if (!string.IsNullOrEmpty(query.MaterialType)) { where.Add("MaterialType = @materialType"); parameters.Add("materialType", query.MaterialType); }
        if (!string.IsNullOrEmpty(query.ProfitCentre)) { where.Add("ProfitCentre = @profitCentre"); parameters.Add("profitCentre", query.ProfitCentre); }
        if (!string.IsNullOrEmpty(query.Search)) { where.Add("(Material LIKE @search OR MaterialText LIKE @search)"); parameters.Add("search", $"%{query.Search}%"); }
        // `material`/`materialText` are separate, independently-combinable filters (each scoped to its own
        // column) — distinct from `search`, which OR's both columns together. Used by the Stock History &
        // Forecast tile's two-field search so a user who already knows the exact part number isn't also
        // matching on description text.
        if (!string.IsNullOrEmpty(query.Material)) { where.Add("Material LIKE @material"); parameters.Add("material", $"%{query.Material}%"); }
        if (!string.IsNullOrEmpty(query.MaterialText)) { where.Add("MaterialText LIKE @materialText"); parameters.Add("materialText", $"%{query.MaterialText}%"); }

        var whereSql = where.Count > 0 ? $"WHERE {string.Join(" AND ", where)}" : "";

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<TurnsValClassRow>(new CommandDefinition($"""
            SELECT
              Material, Plant, MaterialText, CreatedDate, MaterialType, Uom, ProfitCentre,
              DeletionFlag, AbcIndicator, PurchasingGroup, MrpController, ValuationClass,
              LotSizeProcedure, PlanningTimeFence, GrProcessingTime, TotalReplenishmentTime,
              SafetyStock, MinLotSize, MaxLotSize, FixedLotSize, RoundingValue,
              SpecialProcurementType, PlannedDeliveryTime, StockQty, StockValue, UnitPrice, BookValue,
              LastReceiptDate, LastGoodsIssueDate, LastConsumptionDate, LastGoodsMovementDate,
              StockTurns, DaysInStock, DailyRequirementValue, TurnoverCategory, Warning, SnapshotAtUtc
            FROM log.TurnsValClassSnapshot
            {whereSql}
            ORDER BY Material
            """, parameters, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<TurnsValClassAggregates> GetTurnsValClassAggregatesAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var totals = await connection.QuerySingleAsync<TurnsValClassTotals>(new CommandDefinition("""
            SELECT
              COUNT(*) AS MaterialCount,
              SUM(StockValue) AS TotalStockValue,
              SUM(BookValue) AS TotalBookValue,
              SUM(CASE WHEN Warning IS NOT NULL AND Warning <> '' THEN 1 ELSE 0 END) AS WarningCount,
              AVG(CASE WHEN StockTurns IS NOT NULL THEN StockTurns END) AS AvgStockTurns,
              AVG(CASE WHEN DaysInStock IS NOT NULL THEN DaysInStock END) AS AvgDaysInStock
            FROM log.TurnsValClassSnapshot
            """, cancellationToken: ct));

        // Ordered chronologically by days-in-stock bucket (see TurnoverCategoryFor in
        // SapServer/Helpers/PerformanceHelpers.cs for where these exact strings come from) rather
        // than by value — a turnover trend is easier to read left-to-right by age than sorted
        // tallest-bar-first. The three non-numeric states go after the timescale buckets in that
        // order; anything unrecognised falls in at the very end rather than being silently dropped.
        var byTurnoverCategory = await connection.QueryAsync<TurnoverCategoryBucket>(new CommandDefinition("""
            SELECT TurnoverCategory AS Category, COUNT(*) AS MaterialCount, SUM(StockValue) AS StockValue
            FROM log.TurnsValClassSnapshot
            GROUP BY TurnoverCategory
            ORDER BY CASE TurnoverCategory
              WHEN '<10 days' THEN 1
              WHEN '10 - 30 days' THEN 2
              WHEN '31 - 90 days' THEN 3
              WHEN '91 - 180 days' THEN 4
              WHEN '181 - 360 days' THEN 5
              WHEN 'More than 360 days' THEN 6
              WHEN 'No req. in turnover period' THEN 7
              WHEN 'No requirement' THEN 8
              WHEN 'No stock' THEN 9
              WHEN 'Neg. stock' THEN 10
              ELSE 11
            END
            """, cancellationToken: ct));

        var byProfitCentre = await connection.QueryAsync<ProfitCentreBucket>(new CommandDefinition("""
            SELECT ProfitCentre, COUNT(*) AS MaterialCount, SUM(StockValue) AS StockValue, SUM(BookValue) AS BookValue
            FROM log.TurnsValClassSnapshot
            GROUP BY ProfitCentre
            ORDER BY StockValue DESC
            """, cancellationToken: ct));

        var byMaterialType = await connection.QueryAsync<MaterialTypeBucket>(new CommandDefinition("""
            SELECT MaterialType, COUNT(*) AS MaterialCount, SUM(StockValue) AS StockValue
            FROM log.TurnsValClassSnapshot
            GROUP BY MaterialType
            ORDER BY StockValue DESC
            """, cancellationToken: ct));

        return new TurnsValClassAggregates(totals, byTurnoverCategory.AsList(), byProfitCentre.AsList(), byMaterialType.AsList());
    }

    /// <summary>Backs the "Stock Value Over Time" chart — unlike every other query on this tile, this reads log.StockValuationHistory (append-only daily history), not log.TurnsValClassSnapshot (which only ever holds the latest pull, TRUNCATE + reinsert daily, no time dimension).</summary>
    internal static async Task<IReadOnlyList<StockValueHistoryPoint>> GetStockValueHistoryAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<StockValueHistoryPoint>(new CommandDefinition("""
            SELECT SnapshotDate, MaterialType, SUM(StockValue) AS StockValue
            FROM log.StockValuationHistory
            GROUP BY SnapshotDate, MaterialType
            ORDER BY SnapshotDate
            """, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<IReadOnlyList<StockValueByPriceBand>> GetStockValueByPriceAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<StockValueByPriceBand>(new CommandDefinition("""
            SELECT
              CASE
                WHEN UnitPrice IS NULL THEN '(no price)'
                WHEN UnitPrice < 1     THEN '£0 - £1'
                WHEN UnitPrice < 5     THEN '£1 - £5'
                WHEN UnitPrice < 20    THEN '£5 - £20'
                WHEN UnitPrice < 100   THEN '£20 - £100'
                WHEN UnitPrice < 500   THEN '£100 - £500'
                ELSE '£500+'
              END AS PriceBand,
              CASE
                WHEN UnitPrice IS NULL THEN 99
                WHEN UnitPrice < 1     THEN 0
                WHEN UnitPrice < 5     THEN 1
                WHEN UnitPrice < 20    THEN 2
                WHEN UnitPrice < 100   THEN 3
                WHEN UnitPrice < 500   THEN 4
                ELSE 5
              END AS SortOrder,
              COUNT(*) AS MaterialCount,
              SUM(StockQty) AS TotalStockQty,
              SUM(StockValue) AS TotalStockValue
            FROM log.TurnsValClassSnapshot
            GROUP BY
              CASE
                WHEN UnitPrice IS NULL THEN '(no price)'
                WHEN UnitPrice < 1     THEN '£0 - £1'
                WHEN UnitPrice < 5     THEN '£1 - £5'
                WHEN UnitPrice < 20    THEN '£5 - £20'
                WHEN UnitPrice < 100   THEN '£20 - £100'
                WHEN UnitPrice < 500   THEN '£100 - £500'
                ELSE '£500+'
              END,
              CASE
                WHEN UnitPrice IS NULL THEN 99
                WHEN UnitPrice < 1     THEN 0
                WHEN UnitPrice < 5     THEN 1
                WHEN UnitPrice < 20    THEN 2
                WHEN UnitPrice < 100   THEN 3
                WHEN UnitPrice < 500   THEN 4
                ELSE 5
              END
            ORDER BY SortOrder
            """, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<IReadOnlyList<MrpControllerOption>> GetMrpControllersAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<MrpControllerOption>(new CommandDefinition("""
            SELECT MrpController AS Controller, COUNT(*) AS MaterialCount
            FROM log.TurnsValClassSnapshot
            WHERE MrpController IS NOT NULL AND MrpController <> ''
            GROUP BY MrpController
            ORDER BY MrpController
            """, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<IReadOnlyList<ValuationClassCatalogRow>> GetValuationClassesAsync(INexusOperationsDb db, string? materialType, CancellationToken ct)
    {
        var whereSql = string.IsNullOrEmpty(materialType) ? "" : "WHERE MaterialType = @materialType";
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ValuationClassCatalogRow>(new CommandDefinition($"""
            SELECT ValuationClass, MaterialType, AccountRef, Description
            FROM log.ValuationClassCatalog
            {whereSql}
            ORDER BY ValuationClass
            """, new { materialType }, cancellationToken: ct));
        return rows.AsList();
    }
}
