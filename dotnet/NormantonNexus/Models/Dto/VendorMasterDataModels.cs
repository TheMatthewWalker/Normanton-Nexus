namespace NormantonNexus.Models.Dto;

// ── Logistics Sub-phase 8b.2: Vendor master data + demand adjustments ─────
// (MRP Phase 2) — manually-maintained, see log.Vendor/log.VendorMaterial's
// own migration comment for why this isn't sourced from SAP.

public sealed record VendorRow(
    int VendorId, string VendorName, string? SapVendorNumber, string? Currency, string? Incoterms,
    decimal? OrderMoqQty, decimal? OrderMaxQty, string? OrderMoqUom, decimal? DefaultLeadTimeDays, decimal? TransitTimeDays,
    string? Notes, DateTime CreatedAtUtc, DateTime UpdatedAtUtc, int MaterialCount);

/// <summary>Same shape for both POST /vendors and PUT /vendors/:id — Node passes req.body to createVendor/updateVendor identically.</summary>
public sealed record UpsertVendorRequest(
    string VendorName, string? SapVendorNumber, string? Currency, string? Incoterms,
    decimal? OrderMoqQty, decimal? OrderMaxQty, string? OrderMoqUom, decimal? DefaultLeadTimeDays, decimal? TransitTimeDays, string? Notes);

public sealed record VendorMaterialAssignmentRow(
    int VendorMaterialId, int VendorId, string Material, decimal? MaterialMoqQty, decimal? MaterialMaxQty,
    decimal? LeadTimeDaysOverride, decimal? MinSafetyStockQty, string? ScheduleAgreement, string? ScheduleAgreementItem, string? SourceHint,
    string? MaterialText, string? MrpController, decimal? SapLeadTimeDays, decimal? SapSafetyStock);

public sealed record AddVendorMaterialRequest(
    string Material, decimal? MaterialMoqQty, decimal? MaterialMaxQty, decimal? LeadTimeDaysOverride,
    decimal? MinSafetyStockQty, string? ScheduleAgreement, string? ScheduleAgreementItem, string? SourceHint);

/// <summary>ReadingDate-equivalent: Material is deliberately NOT editable here, matching Node's updateVendorMaterial destructuring (no `material` field) — reassigning which material an assignment covers is a delete-and-recreate, not an edit.</summary>
public sealed record UpdateVendorMaterialRequest(
    decimal? MaterialMoqQty, decimal? MaterialMaxQty, decimal? LeadTimeDaysOverride,
    decimal? MinSafetyStockQty, string? ScheduleAgreement, string? ScheduleAgreementItem);

/// <summary>
/// OverrideQty is a deliberate enhancement beyond Node's original percentage-only design (log.DemandAdjustment
/// gained the column here, not ported from Node) — when set, this window plans at a fixed TOTAL quantity spread
/// evenly across the window's days, instead of scaling the normal predicted usage by UsagePercent. The two modes
/// are mutually exclusive per row: OverrideQty (when present) always wins over UsagePercent — see
/// ForecastMathHelper.MakeDailyUsageFn's own comment for the exact math.
/// </summary>
public sealed record DemandAdjustmentRow(
    int AdjustmentId, string Material, DateTime? StartDate, DateTime? EndDate, decimal UsagePercent,
    string? Reason, string? CreatedBy, DateTime CreatedAtUtc, DateTime UpdatedAtUtc, string? MaterialText, decimal? OverrideQty = null);

/// <summary>
/// Same shape for both POST /demand-adjustments and PUT /demand-adjustments/:id. UsagePercent is nullable so a
/// missing value can be rejected distinctly from a literal 0, matching Node's `usagePercent == null` check — but
/// see ValidateDemandAdjustment: UsagePercent is only actually required when OverrideQty is not supplied, since
/// the two are mutually-exclusive planning modes for the same window (percentage scale of normal predicted usage,
/// vs. a fixed total quantity for the whole window). OverrideQty requires both StartDate and EndDate — dividing a
/// total across an unbounded window has no sensible meaning.
/// </summary>
public sealed record UpsertDemandAdjustmentRequest(string Material, DateTime? StartDate, DateTime? EndDate, decimal? UsagePercent, string? Reason, decimal? OverrideQty = null);

/// <summary>AdjustmentId is int, matching log.DemandAdjustment.AdjustmentId's real column type — was long, which throws Dapper's strict-materialization error on every Create/Update Demand Adjustment call (FindOverlappingAdjustmentAsync runs on both paths regardless of whether an overlap is actually found).</summary>
internal sealed record OverlappingAdjustment(int AdjustmentId, DateTime? StartDate, DateTime? EndDate);
