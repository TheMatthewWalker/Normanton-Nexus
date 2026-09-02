namespace NormantonNexus.Models.Dto;

// Stock Count — shared feature between Finance (approve/reject a submitted
// count + Gains/Losses reporting) and Warehouse (creating counts, line
// entry, bin completion, Finished Goods scanning, discrepancy resolution).
// Node: routes/stockcount.js + routes/stockcountsql.js — a single ~1,750
// line pair of files covering both departments' needs.
//
// SCOPE NOTE: this port covers only what Finance's own Stock Adjustments
// tile actually calls (list/approve/reject/report — see dotnet/CLAUDE.md's
// Phase 5 notes for the full route inventory and why). The count-creation/
// line-entry/bin-completion/Finished-Goods-scanning/discrepancy-resolution
// surface (Node's LOG_SUPER-gated routes) is real, unbuilt scope deferred
// to Phase 7 (Warehouse), which owns that department's own vertical slice
// and will extend StockCountController/StockCountHelper rather than
// duplicate them.

public sealed record StockCountDocumentRow(
    int CountId, string CountType, string? StorageLocation, string Status, DateTime? WeekStartDate,
    string? CreatedBy, DateTime CreatedAtUtc,
    string? SubmittedBy, DateTime? SubmittedAtUtc,
    string? ApprovedBy, DateTime? ApprovedAtUtc,
    string? RejectedBy, DateTime? RejectedAtUtc, string? RejectionReason,
    DateTime? PostedAtUtc);

/// <summary>One row per Material for GET /counts/{id}/report (the only groupBy this port implements — see scope note above; groupBy=bin is Warehouse-side).</summary>
public sealed record CountReportRow(string Material, string? MaterialText, string? Uom, decimal CountedQty, decimal? SapQty, decimal? VarianceQty, decimal? VarianceValue);

public sealed record RejectCountRequest(string? Reason);

public sealed record ApproveResultLine(string Material, string? StorageType, string? Bin, bool Success, string? Error, string? MaterialDocument);

public sealed record ApproveCountResult(List<ApproveResultLine> Results, bool AllSucceeded, int PostedLineCount);

public sealed record FinanceReportOffenderRow(string Key, decimal NetValue);

public sealed record FinanceReportCountRow(int CountId, string CountType, string? StorageLocation, string Status, DateTime? DecidedAtUtc, decimal NetValue);

public sealed record FinanceReportResult(
    decimal TotalGains, decimal TotalLosses, decimal Net,
    List<FinanceReportOffenderRow> ByMaterial, List<FinanceReportOffenderRow> ByBin, List<FinanceReportCountRow> Counts);

/// <summary>POST /api/warehouse/stock-adjustment request — mirrors SapServer's StockAdjustmentRequest (StockAdjustmentModels.cs); fields this port doesn't set (Plant, TestRun, PostingDate/DocumentDate, batch/stock-category) left to SapServer's own defaults, matching Node's current call shape exactly.</summary>
public sealed record StockAdjustmentRequest(
    string Material, string StorageLocation, string StorageType, string StorageBin,
    string MovementType, decimal Quantity, string Unit, string? Reference);

/// <summary>Mirrors SapServer's StockAdjustmentResponse — Messages omitted (unused by Node's own approve logic beyond overall Success).</summary>
public sealed record StockAdjustmentResponse(string? MaterialDocument, string? MaterialDocumentYear, bool Success);
