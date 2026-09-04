namespace NormantonNexus.Models.Dto;

// ── Logistics Sub-phase 8b.2: Vendor master data + demand adjustments ─────
// (MRP Phase 2) — manually-maintained, see log.Vendor/log.VendorMaterial's
// own migration comment for why this isn't sourced from SAP.

public sealed record VendorRow(
    long VendorId, string VendorName, string? SapVendorNumber, string? Currency, string? Incoterms,
    decimal? OrderMoqQty, decimal? OrderMaxQty, string? OrderMoqUom, decimal? DefaultLeadTimeDays, decimal? TransitTimeDays,
    string? Notes, DateTime CreatedAtUtc, DateTime UpdatedAtUtc, int MaterialCount);

/// <summary>Same shape for both POST /vendors and PUT /vendors/:id — Node passes req.body to createVendor/updateVendor identically.</summary>
public sealed record UpsertVendorRequest(
    string VendorName, string? SapVendorNumber, string? Currency, string? Incoterms,
    decimal? OrderMoqQty, decimal? OrderMaxQty, string? OrderMoqUom, decimal? DefaultLeadTimeDays, decimal? TransitTimeDays, string? Notes);

public sealed record VendorMaterialAssignmentRow(
    long VendorMaterialId, long VendorId, string Material, decimal? MaterialMoqQty, decimal? MaterialMaxQty,
    decimal? LeadTimeDaysOverride, decimal? MinSafetyStockQty, string? ScheduleAgreement, string? ScheduleAgreementItem, string? SourceHint,
    string? MaterialText, string? MrpController, decimal? SapLeadTimeDays, decimal? SapSafetyStock);

public sealed record AddVendorMaterialRequest(
    string Material, decimal? MaterialMoqQty, decimal? MaterialMaxQty, decimal? LeadTimeDaysOverride,
    decimal? MinSafetyStockQty, string? ScheduleAgreement, string? ScheduleAgreementItem, string? SourceHint);

/// <summary>ReadingDate-equivalent: Material is deliberately NOT editable here, matching Node's updateVendorMaterial destructuring (no `material` field) — reassigning which material an assignment covers is a delete-and-recreate, not an edit.</summary>
public sealed record UpdateVendorMaterialRequest(
    decimal? MaterialMoqQty, decimal? MaterialMaxQty, decimal? LeadTimeDaysOverride,
    decimal? MinSafetyStockQty, string? ScheduleAgreement, string? ScheduleAgreementItem);

public sealed record DemandAdjustmentRow(
    long AdjustmentId, string Material, DateTime? StartDate, DateTime? EndDate, decimal UsagePercent,
    string? Reason, string? CreatedBy, DateTime CreatedAtUtc, DateTime UpdatedAtUtc, string? MaterialText);

/// <summary>Same shape for both POST /demand-adjustments and PUT /demand-adjustments/:id. UsagePercent is nullable so a missing value can be rejected distinctly from a literal 0, matching Node's `usagePercent == null` check.</summary>
public sealed record UpsertDemandAdjustmentRequest(string Material, DateTime? StartDate, DateTime? EndDate, decimal? UsagePercent, string? Reason);

internal sealed record OverlappingAdjustment(long AdjustmentId, DateTime? StartDate, DateTime? EndDate);
