namespace NormantonNexus.Models.Dto;

// ── Logistics Sub-phase 8b.1: shared dashboard/forecast read models ───────

/// <summary>Raw dbo.RefreshLog row — shared by /refresh-log, /refresh-status and /turns-valclass/refresh-status.</summary>
public sealed record RefreshLogRow(int RunId, string? DatasetName, string? Status, DateTime? CompletedAtUtc, string? ErrorMessage);

public sealed record DatasetRefreshStatus(string Name, string Status, DateTime? CompletedAtUtc, string? ErrorMessage);

/// <summary>lastRefreshUtc is null whenever any watched dataset isn't a clean Success — "no false confidence" (see routes/performance.js's own comment).</summary>
public sealed record RefreshStatusResult(DateTime? LastRefreshUtc, IReadOnlyList<DatasetRefreshStatus> Failures, IReadOnlyList<DatasetRefreshStatus> Datasets);

public sealed record ValueMetricRawRow(DateTime MetricDate, string ValueStream, decimal? InvoicedValue, decimal? StockValue, decimal? PickedValue);

/// <summary>OtifOnTimeCount/OtifTotalCount are int, matching log.DailyPerformance's real column type — were long?, throwing Dapper's strict-materialization error on every /otif-metrics request regardless of row content.</summary>
public sealed record OtifMetricRawRow(DateTime MetricDate, string ValueStream, int? OtifOnTimeCount, int? OtifTotalCount);

public sealed record ValueMetricStream(decimal Invoiced, decimal Stock, decimal Picked);

/// <summary>One calendar date's value metrics, pivoted by ValueStream (e.g. "PTFE"/"PV") — dynamic keys, same shape as Node's Object.values(result) output.</summary>
public sealed record ValueMetricsDay(string Date, IReadOnlyDictionary<string, ValueMetricStream> Streams);

public sealed record OtifMetricStream(long OnTime, long Total, decimal Otif);

public sealed record OtifMetricsDay(string Date, IReadOnlyDictionary<string, OtifMetricStream> Streams);

public sealed record OrderBookSummaryRawRow(int Year, int Month, string? ValueStream, decimal? Orders, decimal? Stock, decimal? Picked);

public sealed record OrderBookSummaryRow(int Year, int Month, string? ValueStream, decimal Orders, decimal Stock, decimal Picked);

public sealed record OrderBookBreakdownRawRow(
    string? ValueStream, string? Customer, string? CustomerName, string? ReferenceDocument, string? Material, string? MaterialText,
    DateTime? RequestDate, decimal? OrderQty, decimal? OrderValue, decimal? StockQty, decimal? StockValue, decimal? PickedQty, decimal? PickedValue);

public sealed record OrderBookBreakdownRow(
    string? ValueStream, string? Customer, string? CustomerName, string? ReferenceDocument, string? Material, string? MaterialText,
    string? RequestDate, decimal OrderQty, decimal OrderValue, decimal StockQty, decimal StockValue, decimal PickedQty, decimal PickedValue);

/// <summary>log.TurnsValClassSnapshot, full row shape — Stock History &amp; Forecast tile's underlying data table.</summary>
public sealed record TurnsValClassRow(
    string Material, string Plant, string? MaterialText, DateTime? CreatedDate, string? MaterialType, string? Uom, string? ProfitCentre,
    bool DeletionFlag, string? AbcIndicator, string? PurchasingGroup, string? MrpController, string? ValuationClass,
    string? LotSizeProcedure, decimal? PlanningTimeFence, decimal? GrProcessingTime, decimal? TotalReplenishmentTime,
    decimal? SafetyStock, decimal? MinLotSize, decimal? MaxLotSize, decimal? FixedLotSize, decimal? RoundingValue,
    string? SpecialProcurementType, decimal? PlannedDeliveryTime, decimal? StockQty, decimal? StockValue, decimal? UnitPrice, decimal? BookValue,
    DateTime? LastReceiptDate, DateTime? LastGoodsIssueDate, DateTime? LastConsumptionDate, DateTime? LastGoodsMovementDate,
    decimal? StockTurns, decimal? DaysInStock, decimal? DailyRequirementValue, string? TurnoverCategory, string? Warning, DateTime SnapshotAtUtc);

/// <summary>Optional filters for GET /turns-valclass — every field independently combinable, all optional.</summary>
public sealed record TurnsValClassQuery(string? Plant, string? ValuationClass, string? MrpController, string? MaterialType, string? ProfitCentre, string? Search, string? Material, string? MaterialText);

public sealed record TurnsValClassTotals(int MaterialCount, decimal? TotalStockValue, decimal? TotalBookValue, int WarningCount, decimal? AvgStockTurns, decimal? AvgDaysInStock);

public sealed record TurnoverCategoryBucket(string? Category, int MaterialCount, decimal? StockValue);

public sealed record ProfitCentreBucket(string? ProfitCentre, int MaterialCount, decimal? StockValue, decimal? BookValue);

public sealed record MaterialTypeBucket(string? MaterialType, int MaterialCount, decimal? StockValue);

public sealed record TurnsValClassAggregates(TurnsValClassTotals Totals, IReadOnlyList<TurnoverCategoryBucket> ByTurnoverCategory, IReadOnlyList<ProfitCentreBucket> ByProfitCentre, IReadOnlyList<MaterialTypeBucket> ByMaterialType);

public sealed record StockValueHistoryPoint(DateTime SnapshotDate, string? MaterialType, decimal? StockValue);

public sealed record StockValueByPriceBand(string PriceBand, int SortOrder, int MaterialCount, decimal? TotalStockQty, decimal? TotalStockValue);

public sealed record MrpControllerOption(string Controller, int MaterialCount);

public sealed record ValuationClassCatalogRow(string ValuationClass, string MaterialType, string? AccountRef, string? Description);

// ── Stock History & Forecast tile (GET /turns-valclass/history) ───────────
// The one genuinely missing piece of Sub-phase 8b.1 — flagged there as
// "deferred" pending ForecastMathHelper/the order-suggestion and
// demand-adjustment backends, all of which now exist. Port of
// routes/performance.js's own /turns-valclass/history handler: 13-month
// consumption history vs. SAP demand forecast vs. our own predicted usage,
// plus a 26-week (or, single-material daily view, 60-day) expected-stock
// projection built from ForecastMathHelper.BuildWeeklyStockForecast.

public sealed record IsoparMeterReadingOverlay(bool UsingMeterReading, string? ReadingDate, string? FallbackWarning);

/// <summary>One material's 13-month consumption/forecast/predicted-usage series (index 12 = current month, 0 = 12 months ago), matching Node's own array layout exactly.</summary>
public sealed record TurnsValClassHistoryMaterial(
    string Material, string? MaterialText, string Plant, string? Uom, decimal? StockQty, decimal? ConsignmentQty,
    IReadOnlyList<decimal?> ConsumptionHistory, IReadOnlyList<decimal?> DemandForecast, IReadOnlyList<decimal?> PredictedUsage,
    IsoparMeterReadingOverlay? IsoparMeterReading);

/// <summary>log.ForecastAccuracyLog's frozen-at-month-start figures, aggregated across whatever material set the request resolved to — same 13-slot alignment as TurnsValClassHistoryMaterial's own arrays.</summary>
public sealed record ForecastAccuracyOverlay(IReadOnlyList<decimal?> RecordedSapDemand, IReadOnlyList<decimal?> RecordedPredicted, IReadOnlyList<decimal?> RecordedActual);

public sealed record TurnsValClassHistoryResult(IReadOnlyList<TurnsValClassHistoryMaterial> Data, ForecastAccuracyOverlay Accuracy, WeeklyStockForecastDto StockForecast);

// ── mrpanalysis.js /trends ─────────────────────────────────────────────────

public sealed record ConsumptionByYearRow(string Material, string? MaterialText, int FiscalYear, decimal? ConsumedQty);

public sealed record ReceiptHistoryByVendorRow(string Material, string? MaterialText, int? VendorId, string? VendorName, string? SapVendorNumber, int FiscalYear, decimal? ReceivedQty, string? Uom);

public sealed record MrpTrendsResult(IReadOnlyList<ConsumptionByYearRow> Consumption, IReadOnlyList<ReceiptHistoryByVendorRow> Receipts);

// ── Logistics Sub-phase 8b.6: consignment customers + production-plan print ──

public sealed record ConsignmentCustomerRow(string Customer, string? CustomerName, DateTime LastUpdatedUtc, string? UpdatedByUsername);

public sealed record UpsertConsignmentCustomerRequest(string? CustomerName);

/// <summary>log.OrderBookLineNotes, one row per (ReferenceDocument, Material) — the manual Month End Breakdown columns (Risk/Reason, Won't Get, Last Day/Time, Bring Forward, a Planned Production Qty override). Risk is read but never round-tripped from an upload any more (calculated on the Data sheet now) — kept here only because Node's own listOrderBookLineNotes still returns it.</summary>
public sealed record OrderBookLineNote(string? Risk, string? Reason, string? WontGet, string? LastDay, string? LastDayTime, string? BringForward, decimal? PlannedProductionQty);

public sealed record ProductionPlanLine(string Time, string Customer, string Material, string? MaterialText, decimal Quantity, decimal Value);
