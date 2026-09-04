namespace NormantonNexus.Models.Dto;

// ── Logistics Sub-phase 8b.3: Order suggestion engine (MRP Phase 2b) ──────
// See sql/migrate_order_suggestions.sql for the full design writeup. Not
// just-in-time: materials are flagged off a maintained safety-stock FLOOR
// (VendorMaterial.MinSafetyStockQty, falling back to SAP's own MARC-EISBE),
// not off hitting zero — frequent supplier date slips mean a buffer is kept
// on purpose.

/// <summary>One vendor+material assignment joined with everything the suggestion engine needs from TurnsValClassSnapshot. LEFT JOIN — a material can be assigned to a vendor without (yet) having synced into TurnsValClassSnapshot; those rows come back with null stock/usage and are skipped (nothing to compute without SAP data).</summary>
public sealed record VendorMaterialForSuggestionRow(
    long VendorMaterialId, long VendorId, string Material, decimal? MaterialMoqQty, decimal? MaterialMaxQty,
    decimal? LeadTimeDaysOverride, decimal? MinSafetyStockQty, string? ScheduleAgreement,
    string VendorName, string? Incoterms, decimal? OrderMoqQty, decimal? OrderMaxQty, string? OrderMoqUom,
    decimal? DefaultLeadTimeDays, decimal? TransitTimeDays,
    string? MaterialText, string? Uom, string? MrpController, decimal? StockQty, decimal? ConsignmentQty,
    decimal? SapSafetyStock, decimal? SapLeadTimeDays,
    decimal? PredictedM12, decimal? PredictedM11, decimal? PredictedM10, decimal? PredictedM09, decimal? PredictedM08, decimal? PredictedM07,
    decimal? PredictedM06, decimal? PredictedM05, decimal? PredictedM04, decimal? PredictedM03, decimal? PredictedM02, decimal? PredictedM01, decimal? PredictedM00);

public sealed record IsoparForecastContext(IsoparReadingRow? LatestReading, IsoparPlanningRateRow? PlanningRate);

public sealed record IsoparMeterReadingInfo(bool UsingMeterReading, string? ReadingDate, string? FallbackWarning);

/// <summary>One vendor-material row's full suggestion picture — used both for the "needs ordering now" list (filtered to dueNow) and the Build Order modal (unfiltered).</summary>
public sealed record OrderSuggestion(
    long VendorMaterialId, long VendorId, string VendorName, string Material, string? MaterialText, string? Uom, string? MrpController,
    decimal CurrentStock, decimal OpenIncomingQty, decimal SafetyStockQty, string? BreachDate, decimal LeadTimeDays, decimal TransitTimeDays,
    string? OrderByDate, string Urgency, bool DueNow, decimal SuggestedQty,
    decimal? MaterialMoqQty, decimal? MaterialMaxQty, decimal? OrderMoqQty, decimal? OrderMaxQty, string? OrderMoqUom,
    string? Incoterms, bool IsSpotPo, string? ScheduleAgreement, IsoparMeterReadingInfo? IsoparMeterReading);

public sealed record VendorSuggestionGroup(
    long VendorId, string VendorName, decimal? OrderMoqQty, decimal? OrderMaxQty, string? OrderMoqUom, IReadOnlyList<OrderSuggestion> Materials,
    decimal CombinedQty, bool IsExactQty, bool MoqMet, decimal MoqShortfall, decimal MoqOverage, string? EarliestOrderByDate);

public sealed record VendorOrderBuildResult(long VendorId, string? VendorName, decimal? OrderMoqQty, decimal? OrderMaxQty, string? OrderMoqUom, decimal? DefaultLeadTimeDays, IReadOnlyList<OrderSuggestion> Materials);

public sealed record OrderSuggestionPreviewItem(string Material, decimal? OrderQty);

public sealed record OrderSuggestionPreviewRequest(DateTime? DeliveryDate, List<OrderSuggestionPreviewItem>? Items);

// Public mirror of ForecastMathHelper's internal WeeklyStockForecast/ForecastWeek/ForecastDelivery
// shapes — needed because a public DTO can't expose a member whose type lives inside an internal
// class (CS0053). PerformanceForecastMapper.ToDto maps one to the other at the API boundary.
public sealed record ForecastDeliveryDto(long? Id, string? PoNumber, decimal Qty, string? Material);

public sealed record ForecastWeekDto(string WeekEnding, decimal WeeklyUsage, decimal IncomingQty, IReadOnlyList<ForecastDeliveryDto> Deliveries, decimal ExpectedStock);

public sealed record WeeklyStockForecastDto(string? AsOfDate, decimal CurrentStock, IReadOnlyList<ForecastWeekDto> Weeks, int BucketDays);

public sealed record OrderSuggestionPreviewResult(string? Material, string? MaterialText, WeeklyStockForecastDto? StockForecast, string? Error);

public sealed record AcceptOrderSuggestionRequest(
    long? VendorMaterialId, long? VendorId, string? Material, decimal? SuggestedQty, decimal? OrderQty, DateTime? OrderDate,
    decimal? LeadTimeDays, decimal? TransitTimeDays, bool? IsSpotPo, string? Notes, DateTime? DeliveryDate);

public sealed record AcceptOrderSuggestionResult(long SuggestionId, decimal OrderQty);

public sealed record AcceptBatchItem(
    long? VendorMaterialId, string? Material, decimal? SuggestedQty, decimal? OrderQty,
    decimal? LeadTimeDays, decimal? TransitTimeDays, bool? IsSpotPo, string? Notes, DateTime? DeliveryDate);

public sealed record AcceptOrderSuggestionBatchRequest(long? VendorId, DateTime? OrderDate, List<AcceptBatchItem>? Items);

public sealed record AcceptOrderSuggestionBatchResult(IReadOnlyList<long> SuggestionIds, decimal TotalQty);

public sealed record ManualOrderRequest(
    long? VendorMaterialId, decimal? OrderQty, DateTime? OrderDate, DateTime? DeliveryDate,
    string? PoNumber, string? Notes, string? Status, string? SupplierReference);

public sealed record ManualOrderResult(long SuggestionId);

public sealed record ManualOrderBulkRow(
    string? Vendor, string? Material, decimal? OrderQty, DateTime? OrderDate, DateTime? DeliveryDate,
    string? PoNumber, string? SupplierReference, string? Notes, string? Status);

public sealed record ManualOrderBulkRequest(List<ManualOrderBulkRow>? Rows);

public sealed record ManualOrderBulkRowResult(int Row, bool Success, long? SuggestionId, string? Error);

public sealed record ManualOrderBulkResult(int Total, int Succeeded, int Failed, IReadOnlyList<ManualOrderBulkRowResult> Results);

/// <summary>Everything except Cancelled — cancelled rows are kept for audit but excluded from this view.</summary>
public sealed record OrderSuggestionTrackedRow(
    long SuggestionId, long VendorId, string VendorName, string? SapVendorNumber, string? Currency, string? OrderMoqUom, string? Incoterms,
    long VendorMaterialId, string Material, string? MaterialText, string? Uom, string Status, decimal? SuggestedQty, decimal OrderQty, DateTime OrderDate,
    decimal? LeadTimeDaysUsed, DateTime? DeliveryDate, decimal? TransitTimeDaysUsed, DateTime? ReadyToCollectDate,
    bool IsSpotPo, string? PoNumber, string? PoItemNumber, string? Notes, string? SupplierReference,
    DateTime CreatedAtUtc, DateTime UpdatedAtUtc, DateTime? ReceivedAtUtc,
    long? ShipmentId, string? ShipmentReference, string? Haulier, string? ModeOfTransport,
    string? ShipmentTrackingNumber, DateTime? ExpectedEta, DateTime? ShipmentReceivedAtUtc,
    string? ScheduleAgreement, string? ScheduleAgreementItem);

public sealed record AssignScheduleAgreementRequest(List<long>? SuggestionIds);

public sealed record AssignScheduleAgreementResult(IReadOnlyList<long> SuggestionIds);

/// <summary>Full-row update (same convention as UpdateVendorAsync) — the caller sends the complete current state, not a partial patch, so PoNumber/Notes/SupplierReference need to be included even when only Status is changing. OrderQty/DeliveryDate/ReadyToCollectDate are COALESCE-optional (only touch the row when supplied).</summary>
public sealed record UpdateOrderSuggestionStatusRequest(
    string? Status, string? PoNumber, string? PoItemNumber, string? Notes, string? SupplierReference,
    decimal? OrderQty, DateTime? DeliveryDate, DateTime? ReadyToCollectDate);

public sealed record UpdateOrderSuggestionPoItemRequest(string? PoItemNumber);

public sealed record VendorMaterialConstraints(decimal? MaterialMoqQty, decimal? MaterialMaxQty);

public sealed record VendorOrderConstraints(string? VendorName, decimal? OrderMoqQty, decimal? OrderMaxQty, string? OrderMoqUom);
