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

// ── Sub-phase 8b.6: HMRC Tied Oil declarations (log.IsoparDeclaration) ──────

/// <summary>One Isopar delivery received within a declaration period — log.PurchaseOrderSuggestion joined to its log.PurchaseOrderShipment for whichever received-date is available.</summary>
public sealed record IsoparReceivedDeliveryRow(long SuggestionId, decimal OrderQty, decimal? ReceivedQty, string? PoNumber, DateTime? ReceivedDate);

/// <summary>Shared by both the live "outstanding period" preview and the frozen submit path, so the two can never drift apart. Complete:false (missing an opening or closing reading) must block submission.</summary>
public sealed record IsoparPeriodFigures(
    DateTime PeriodStart, DateTime PeriodEnd, IsoparReadingRow? OpeningReading, IsoparReadingRow? ClosingReading,
    decimal? OpeningStockQty, decimal? ClosingStockQty, decimal ReceivedQty, decimal? ConsumedQty,
    IReadOnlyList<IsoparReceivedDeliveryRow> Deliveries, bool Complete);

public sealed record IsoparDeclarationRow(
    long DeclarationId, DateTime PeriodStart, DateTime PeriodEnd, decimal OpeningStockQty, decimal ReceivedQty, decimal ClosingStockQty, decimal ConsumedQty,
    long? OpeningReadingId, long? ClosingReadingId, string? Notes, int SubmittedByUserId, string? SubmittedByUsername, DateTime SubmittedAtUtc);

/// <summary>One fully-ended period with no declaration yet, plus its live-computed figures — what the "Confirm & Submit" cards show.</summary>
public sealed record IsoparOutstandingPeriod(int Index, DateTime Start, DateTime End, IsoparPeriodFigures Figures);

public sealed record IsoparCurrentPeriodPreviewResult(DateTime Start, DateTime End, IsoparPeriodFigures Figures);

/// <summary>Body only carries which period is being confirmed — the server never trusts client-submitted figures, it recomputes them fresh at submit time via the same IsoparDeclarationHelper.ComputePeriodFiguresAsync the preview uses.</summary>
public sealed record CreateIsoparDeclarationRequest(DateTime? PeriodStart, DateTime? PeriodEnd, string? Notes);

public sealed record CreateIsoparDeclarationResult(long DeclarationId);

/// <summary>checkIsoparDeclarationDue's result — self-healing/idempotent rather than exact-day-gated (see IsoparDeclarationHelper.CheckDeclarationDueAsync).</summary>
public sealed record IsoparDeclarationDueCheckResult(bool Notified, bool AlreadySent = false, string? PeriodEnd = null);
