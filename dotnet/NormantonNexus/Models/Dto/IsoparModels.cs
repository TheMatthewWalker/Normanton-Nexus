namespace NormantonNexus.Models.Dto;

// ── Logistics Sub-phase 8b.2: Isopar Tied Oil (Material 10010) — meter-
// reading-driven planning. See migrations/nexus_operations/20260813090000_isopar_tied_oil.cjs
// for the schema rationale. Declarations (ISOPAR_DECL-gated) are deferred to
// Sub-phase 8b.6 alongside checkIsoparDeclarationDue's INotificationService wiring.

public sealed record IsoparReadingRow(long ReadingId, DateTime ReadingDate, decimal ReadingQty, string? Notes, string? CreatedBy, DateTime CreatedAtUtc, DateTime UpdatedAtUtc);

public sealed record CreateIsoparReadingRequest(DateTime? ReadingDate, decimal? ReadingQty, string? Notes);

/// <summary>ReadingDate is deliberately NOT editable — reassigning which day a reading belongs to could silently move it across a period boundary or collide with another row. A wrong date is a delete-and-recreate, not an edit.</summary>
public sealed record UpdateIsoparReadingRequest(decimal? ReadingQty, string? Notes);

public sealed record IsoparPlanningRateRow(long RateId, decimal WeekdayRateLPerDay, decimal WeekendRateLPerDay, decimal? MaxStockCapacityQty, string? Source, string? Notes, string? CreatedBy, DateTime CreatedAtUtc);

/// <summary>Partial updates allowed — a field left out carries forward from the current row (see IsoparHelper.UpdatePlanningRateAsync's merge). "Apply Recommended Rate" only sends weekday/weekend; the settings form's own Save button sends all three.</summary>
public sealed record UpdateIsoparPlanningRateRequest(decimal? WeekdayRateLPerDay, decimal? WeekendRateLPerDay, decimal? MaxStockCapacityQty, string? Source, string? Notes);

public sealed record IsoparPlanningRateActual(decimal? WeekdayAvgLPerDay, decimal? WeekendAvgLPerDay, int SampleIntervals, DateTime? FromDate, DateTime? ToDate);

public sealed record IsoparPlanningRateRecommendation(decimal WeekdayRateLPerDay, decimal WeekendRateLPerDay);

public sealed record IsoparPlanningRateResult(IsoparPlanningRateRow? Current, IsoparPlanningRateActual Actual, IsoparPlanningRateRecommendation? Recommendation);

public sealed record IsoparStockRiskResult(string? AsOfDate, decimal CurrentStock, decimal? MaxStockCapacityQty, string? StockoutDate, string? OverCapacityDate);

/// <summary>log.PurchaseOrderSuggestion row (Accepted/Ordered, not yet Received/Cancelled) — "already incoming" quantity, shared by Isopar stock-risk here and the order-suggestion engine (8b.3).</summary>
public sealed record OpenIncomingOrderRow(long SuggestionId, string Material, decimal OrderQty, DateTime? DeliveryDate, string Status, string? PoNumber);
