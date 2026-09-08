using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Logistics Sub-phase 8b.1 — the simplest read-only Purchasing/Performance
/// dashboard routes: refresh log/status (dbo.RefreshLog, Nexus database),
/// value/OTIF metrics and order-book summary/breakdown (log.DailyPerformance/
/// log.AgreementSnapshot, NexusOperations), and the Stock Value Overview
/// (Turns/Valuation Class) tile's read side (log.TurnsValClassSnapshot/
/// log.StockValuationHistory/log.ValuationClassCatalog), and — added later,
/// once ForecastMathHelper/the order-suggestion and demand-adjustment
/// backends existed to build it on — GetTurnsValClassHistoryAsync, the
/// Stock History &amp; Forecast tile's own data route
/// (GET /turns-valclass/history). No SAP calls, no writes — port of the
/// corresponding GET routes in routes/performance.js (see PerformanceController).
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

    private sealed record TurnsValClassHistoryRawRow(
        string Material, string? MaterialText, string Plant, string? Uom, decimal? StockQty, decimal? ConsignmentQty,
        decimal? HistoryM12, decimal? HistoryM11, decimal? HistoryM10, decimal? HistoryM09, decimal? HistoryM08, decimal? HistoryM07,
        decimal? HistoryM06, decimal? HistoryM05, decimal? HistoryM04, decimal? HistoryM03, decimal? HistoryM02, decimal? HistoryM01, decimal? HistoryM00,
        decimal? ForecastM12, decimal? ForecastM11, decimal? ForecastM10, decimal? ForecastM09, decimal? ForecastM08, decimal? ForecastM07,
        decimal? ForecastM06, decimal? ForecastM05, decimal? ForecastM04, decimal? ForecastM03, decimal? ForecastM02, decimal? ForecastM01, decimal? ForecastM00,
        decimal? PredictedM12, decimal? PredictedM11, decimal? PredictedM10, decimal? PredictedM09, decimal? PredictedM08, decimal? PredictedM07,
        decimal? PredictedM06, decimal? PredictedM05, decimal? PredictedM04, decimal? PredictedM03, decimal? PredictedM02, decimal? PredictedM01, decimal? PredictedM00);

    /// <summary>
    /// Stock History &amp; Forecast tile's data route — GET /turns-valclass/history in Node.
    /// Every material's own weekly stock forecast is built separately then summed
    /// (ForecastMathHelper.MergeWeeklyForecasts), not aggregated up front, since a demand
    /// adjustment can apply to one material in a combined/MRP-controller view and not
    /// another — matches Node's own comment on this exactly. onHandStock intentionally
    /// includes ConsignmentQty here (the only place the two are summed anywhere in this
    /// app) since what's physically available to consume is what matters for MRP/shipment
    /// planning, unlike every valuation-facing reader of StockQty elsewhere on this tile.
    /// </summary>
    internal static async Task<TurnsValClassHistoryResult> GetTurnsValClassHistoryAsync(
        INexusOperationsDb db, IReadOnlyList<string>? materials, string? mrpController,
        IReadOnlyList<int>? excludeDeliveryIds, bool dailyBucketRequested, CancellationToken ct)
    {
        var conditions = new List<string>();
        if (materials is { Count: > 0 }) conditions.Add("Material IN @materials");
        if (!string.IsNullOrWhiteSpace(mrpController)) conditions.Add("MrpController = @mrpController");
        var whereSql = conditions.Count > 0 ? $"WHERE {string.Join(" AND ", conditions)}" : "";

        using var connection = await db.CreateConnectionAsync(ct);
        var rawRows = (await connection.QueryAsync<TurnsValClassHistoryRawRow>(new CommandDefinition($"""
            SELECT
              Material, MaterialText, Plant, Uom, StockQty, ConsignmentQty,
              HistoryM12, HistoryM11, HistoryM10, HistoryM09, HistoryM08, HistoryM07,
              HistoryM06, HistoryM05, HistoryM04, HistoryM03, HistoryM02, HistoryM01, HistoryM00,
              ForecastM12, ForecastM11, ForecastM10, ForecastM09, ForecastM08, ForecastM07,
              ForecastM06, ForecastM05, ForecastM04, ForecastM03, ForecastM02, ForecastM01, ForecastM00,
              PredictedM12, PredictedM11, PredictedM10, PredictedM09, PredictedM08, PredictedM07,
              PredictedM06, PredictedM05, PredictedM04, PredictedM03, PredictedM02, PredictedM01, PredictedM00
            FROM log.TurnsValClassSnapshot
            {whereSql}
            ORDER BY Material
            """, new { materials, mrpController }, cancellationToken: ct))).AsList();

        var materialsInScope = rawRows.Select(r => r.Material).ToList();
        var excludeSet = excludeDeliveryIds is { Count: > 0 } ? new HashSet<int>(excludeDeliveryIds) : null;

        // Only pass materialsInScope down as an explicit filter when the caller actually
        // narrowed the snapshot query (materials or mrpController) — an unfiltered "Show
        // All" resolves materialsInScope to every material in the whole plant (thousands
        // of rows), and hammering that into a Dapper `IN @materials` expansion (one SQL
        // parameter per value) either blows past SQL Server's ~2100 parameter limit or is
        // slow enough to trip the request's own cancellation token ("Operation cancelled
        // by user" — confirmed for real against a live deploy). Passing null instead (no
        // filter) is exactly as correct here: both queries are grouped by Material via
        // ToLookup afterward regardless of how many extra materials came back.
        var hasExplicitFilter = materials is { Count: > 0 } || !string.IsNullOrWhiteSpace(mrpController);
        var incomingTask = PurchaseOrderSuggestionHelper.ListOpenIncomingOrdersAsync(db, hasExplicitFilter ? materialsInScope : null, ct);
        var adjustmentsTask = VendorMasterDataHelper.ListDemandAdjustmentsAsync(db, hasExplicitFilter ? materialsInScope : null, ct);
        var isoparContextTask = IsoparHelper.GetForecastContextAsync(db, ct);
        await Task.WhenAll(incomingTask, adjustmentsTask, isoparContextTask);

        var incomingByMaterial = (await incomingTask).ToLookup(o => o.Material);
        var adjustmentsByMaterial = (await adjustmentsTask).ToLookup(a => a.Material);
        var isoparContext = await isoparContextTask;

        var useDailyBuckets = materialsInScope.Count == 1
            && (materialsInScope[0] == IsoparPeriodHelper.IsoparMaterial || dailyBucketRequested);

        var data = new List<TurnsValClassHistoryMaterial>();
        var perMaterialForecasts = new List<ForecastMathHelper.WeeklyStockForecast>();
        var now = DateTime.UtcNow;

        foreach (var r in rawRows)
        {
            var consumptionHistory = new decimal?[]
            {
                r.HistoryM12, r.HistoryM11, r.HistoryM10, r.HistoryM09, r.HistoryM08, r.HistoryM07,
                r.HistoryM06, r.HistoryM05, r.HistoryM04, r.HistoryM03, r.HistoryM02, r.HistoryM01, r.HistoryM00,
            };
            var demandForecast = new decimal?[]
            {
                r.ForecastM12, r.ForecastM11, r.ForecastM10, r.ForecastM09, r.ForecastM08, r.ForecastM07,
                r.ForecastM06, r.ForecastM05, r.ForecastM04, r.ForecastM03, r.ForecastM02, r.ForecastM01, r.ForecastM00,
            };
            var predictedMonthly = new[]
            {
                r.PredictedM12 ?? 0m, r.PredictedM11 ?? 0m, r.PredictedM10 ?? 0m, r.PredictedM09 ?? 0m, r.PredictedM08 ?? 0m, r.PredictedM07 ?? 0m,
                r.PredictedM06 ?? 0m, r.PredictedM05 ?? 0m, r.PredictedM04 ?? 0m, r.PredictedM03 ?? 0m, r.PredictedM02 ?? 0m, r.PredictedM01 ?? 0m, r.PredictedM00 ?? 0m,
            };

            var onHandStock = (r.StockQty ?? 0m) + (r.ConsignmentQty ?? 0m);

            var isIsopar = r.Material == IsoparPeriodHelper.IsoparMaterial;
            var isoparReading = isIsopar ? isoparContext.LatestReading : null;
            var usingMeterReading = isIsopar && isoparReading is not null;
            var effectiveOnHandStock = usingMeterReading ? isoparReading!.ReadingQty : onHandStock;
            var isoparDailyUsageFnOverride = (usingMeterReading && isoparContext.PlanningRate is not null)
                ? ForecastMathHelper.MakeIsoparDailyUsageFn(isoparContext.PlanningRate.WeekdayRateLPerDay, isoparContext.PlanningRate.WeekendRateLPerDay)
                : null;

            IsoparMeterReadingOverlay? isoparOverlay = isIsopar
                ? new IsoparMeterReadingOverlay(usingMeterReading, isoparReading?.ReadingDate.ToString("yyyy-MM-dd"),
                    usingMeterReading ? null : "No Isopar meter reading recorded yet — showing SAP stock figures until the first reading is entered.")
                : null;

            data.Add(new TurnsValClassHistoryMaterial(r.Material, r.MaterialText, r.Plant, r.Uom, r.StockQty, r.ConsignmentQty,
                consumptionHistory, demandForecast, Array.ConvertAll(predictedMonthly, v => (decimal?)v), isoparOverlay));

            var incomingDeliveries = incomingByMaterial[r.Material]
                .Where(o => o.DeliveryDate.HasValue && (excludeSet is null || !excludeSet.Contains(o.SuggestionId)))
                .Select(o => new ForecastMathHelper.IncomingDelivery(o.DeliveryDate!.Value, o.OrderQty, o.SuggestionId, o.PoNumber, o.VendorName))
                .ToList();
            var materialAdjustments = adjustmentsByMaterial[r.Material]
                .Select(a => new ForecastMathHelper.DemandAdjustmentWindow(a.StartDate, a.EndDate, a.UsagePercent, a.OverrideQty))
                .ToList();

            perMaterialForecasts.Add(ForecastMathHelper.BuildWeeklyStockForecast(
                effectiveOnHandStock, predictedMonthly, now, incomingDeliveries, materialAdjustments,
                isoparDailyUsageFnOverride, useDailyBuckets ? 1 : 7));
        }

        var stockForecast = ForecastMathHelper.MergeWeeklyForecasts(perMaterialForecasts, materialsInScope);
        var horizon = useDailyBuckets ? PurchaseOrderSuggestionHelper.IsoparDailyForecastHorizonDays : 26;
        stockForecast = stockForecast with { Weeks = stockForecast.Weeks.Take(horizon).ToList() };

        // ── Recorded accuracy overlay (log.ForecastAccuracyLog) ────────────
        var thisMonth = new DateTime(now.Year, now.Month, 1, 0, 0, 0, DateTimeKind.Utc);
        var fromMonth = thisMonth.AddMonths(-12);
        // Scoped by the caller's own explicit `materials` filter only — matching Node's
        // real route exactly (it never scopes this query by mrpController or the resolved
        // materialsInScope set, only req.query.materials). Also sidesteps the same
        // huge-IN-clause risk an unfiltered "Show All" would hit if this used
        // materialsInScope instead (thousands of materials into one Dapper `IN` expansion).
        var accuracyConditions = new List<string> { "TargetMonth >= @fromMonth AND TargetMonth <= @toMonth" };
        if (materials is { Count: > 0 }) accuracyConditions.Add("Material IN @materials");

        var accuracyRows = await connection.QueryAsync<(DateTime TargetMonth, decimal? SapDemandQty, decimal? PredictedQty, decimal? ActualQty)>(
            new CommandDefinition($"""
                SELECT TargetMonth, SUM(SapDemandQty) AS SapDemandQty, SUM(PredictedQty) AS PredictedQty, SUM(ActualQty) AS ActualQty
                FROM log.ForecastAccuracyLog
                WHERE {string.Join(" AND ", accuracyConditions)}
                GROUP BY TargetMonth
                ORDER BY TargetMonth
                """, new { fromMonth, toMonth = thisMonth, materials }, cancellationToken: ct));

        var recordedSapDemand = new decimal?[13];
        var recordedPredicted = new decimal?[13];
        var recordedActual = new decimal?[13];
        foreach (var row in accuracyRows)
        {
            var monthsBack = (thisMonth.Year - row.TargetMonth.Year) * 12 + (thisMonth.Month - row.TargetMonth.Month);
            if (monthsBack is < 0 or > 12) continue;
            var idx = 12 - monthsBack;
            recordedSapDemand[idx] = row.SapDemandQty;
            recordedPredicted[idx] = row.PredictedQty;
            recordedActual[idx] = row.ActualQty;
        }

        return new TurnsValClassHistoryResult(
            data,
            new ForecastAccuracyOverlay(recordedSapDemand, recordedPredicted, recordedActual),
            PurchaseOrderSuggestionHelper.ToDto(stockForecast));
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

    // ── Consignment customers (log.ConsignmentCustomer) — Sub-phase 8b.6 ────
    // Customers on a consignment stock agreement, excluded from
    // GetOrderBookSummaryAsync/GetOrderBookBreakdownAsync above (see those
    // methods' own LEFT JOIN comments) so they stop inflating the Month End
    // Order Book export and the Management page's KPI cards. Read: any
    // logged-in user. Write: LOG_ADMIN (enforced by the controller).

    internal static async Task<IReadOnlyList<ConsignmentCustomerRow>> ListConsignmentCustomersAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ConsignmentCustomerRow>(new CommandDefinition("""
            SELECT Customer, CustomerName, LastUpdatedUtc, UpdatedByUsername
            FROM log.ConsignmentCustomer
            ORDER BY Customer
            """, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task UpsertConsignmentCustomerAsync(INexusOperationsDb db, string customer, UpsertConsignmentCustomerRequest body, string? username, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(customer)) throw new NexusValidationException("Customer number is required.");

        using var connection = await db.CreateConnectionAsync(ct);
        var exists = await connection.ExecuteScalarAsync<int?>(new CommandDefinition(
            "SELECT 1 FROM log.ConsignmentCustomer WHERE Customer = @customer", new { customer }, cancellationToken: ct));

        if (exists is not null)
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE log.ConsignmentCustomer
                SET CustomerName = @CustomerName, LastUpdatedUtc = GETUTCDATE(), UpdatedByUsername = @username
                WHERE Customer = @customer
                """, new { body.CustomerName, username, customer }, cancellationToken: ct));
        }
        else
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO log.ConsignmentCustomer (Customer, CustomerName, LastUpdatedUtc, UpdatedByUsername)
                VALUES (@customer, @CustomerName, GETUTCDATE(), @username)
                """, new { customer, body.CustomerName, username }, cancellationToken: ct));
        }
    }

    internal static async Task DeleteConsignmentCustomerAsync(INexusOperationsDb db, string customer, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "DELETE FROM log.ConsignmentCustomer WHERE Customer = @customer", new { customer }, cancellationToken: ct));
    }

    // ── Order book line notes (log.OrderBookLineNotes) — Sub-phase 8b.6 ─────
    // Keyed by "${ReferenceDocument}||${Material}" — same grain as a
    // getOrderBookBreakdown() row — feeding both the Month End Breakdown
    // export prefill (deferred to 8b.6's Excel-export slice) and the
    // Production Plan print report below.

    internal static async Task<IReadOnlyDictionary<string, OrderBookLineNote>> ListOrderBookLineNotesAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<(string ReferenceDocument, string Material, string? Risk, string? Reason, string? WontGet, string? LastDay, string? LastDayTime, string? BringForward, decimal? PlannedProductionQty)>(
            new CommandDefinition("""
                SELECT ReferenceDocument, Material, Risk, Reason, WontGet, LastDay, LastDayTime, BringForward, PlannedProductionQty
                FROM log.OrderBookLineNotes
                """, cancellationToken: ct));

        return rows.ToDictionary(
            r => $"{r.ReferenceDocument}||{r.Material}",
            r => new OrderBookLineNote(r.Risk, r.Reason, r.WontGet, r.LastDay, r.LastDayTime, r.BringForward, r.PlannedProductionQty));
    }
}
