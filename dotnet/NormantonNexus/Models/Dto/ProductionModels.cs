namespace NormantonNexus.Models.Dto;

// Production department, Sub-phase 6a: Reports + Batch History + Traceability
// — the read-only slice of routes/productionnexus.js that needs no new
// SapServer endpoint and no writeEvent/notify infrastructure (none of
// these tiles write anything except the trace-link create). The
// entry/completion/scrap/reversal/drumming/labels surface is real,
// researched, unbuilt scope — deferred to Sub-phases 6b/6c, see
// dotnet/CLAUDE.md's Phase 6 notes for the full route inventory and the
// reasoning behind this split.

public sealed record ReportFilterQuery(string? DateFrom, string? DateTo, string? ProcessCode, string? Material, string GroupBy = "day");

public sealed record ReportOutputSummaryRow(string ProcessCode, string Uom, int BatchCount, decimal TotalOutput, decimal AvgPerBatch);
public sealed record ReportOutputSeriesRow(string ProcessCode, string Uom, string Period, int BatchCount, decimal TotalOutput);
public sealed record ReportOutputResult(List<ReportOutputSummaryRow> Summary, List<ReportOutputSeriesRow> TimeSeries);

public sealed record ReportScrapTotals(decimal TotalKg, int EntryCount, string TopReason);
public sealed record ReportScrapByReasonRow(string ReasonCode, string ReasonDescription, decimal TotalKg, int EntryCount);
public sealed record ReportScrapByProcessRow(string ProcessCode, decimal TotalKg, int EntryCount);
public sealed record ReportScrapSeriesRow(string Period, decimal TotalKg, int EntryCount);
public sealed record ReportScrapResult(ReportScrapTotals Totals, List<ReportScrapByReasonRow> ByReason, List<ReportScrapByProcessRow> ByProcess, List<ReportScrapSeriesRow> TimeSeries);

public sealed record ReportSapPerfByProcessRow(string ProcessCode, int Total, int Success, int Failed, int Reversed);
public sealed record ReportSapPerfSeriesRow(string Period, int Success, int Failed);
public sealed record ReportSapPerfAlertRow(string ProcessCode, int AlertCount);
public sealed record ReportSapPerfResult(List<ReportSapPerfByProcessRow> ByProcess, List<ReportSapPerfSeriesRow> TimeSeries, List<ReportSapPerfAlertRow> Alerts);

public sealed record ReportBatchStatusRow(string ProcessCode, int Reversed, int Complete, int SapFailed, int Cancelled, int Total);

public sealed record ReportShiftOutputRow(string ShiftName, string ProcessCode, string Uom, int BatchCount, decimal TotalOutput);
public sealed record ReportShiftScrapRow(string ProcessCode, decimal ScrapKg, int EntryCount);
public sealed record ReportShiftResult(List<ReportShiftOutputRow> Output, List<ReportShiftScrapRow> ScrapByProcess);

public sealed record ReportOperatorOutputRow(string Username, string ProcessCode, string Uom, int BatchCount, decimal TotalOutput);

public sealed record ReportMaterialOutputRow(string Material, string ProcessCode, string Uom, int BatchCount, decimal TotalOutput, decimal AvgPerBatch);

public sealed record BatchHistoryQuery(string? ProcessCode, string? Material, string? Ref, string? FromDate, string? ToDate, int Page = 1, int PageSize = 50);
public sealed record BatchHistoryRow(string ProcessCode, int RecordId, string BatchRef, string Material, decimal Quantity, string Uom, int Status, DateTime CreatedAt, DateTime? CompletedAt);

public sealed record TraceLinkCreateRequest(string ChildProcessCode, int ChildRecordId, string ParentProcessCode, int ParentRecordId);
public sealed record TraceChainLink(string ChildProcessCode, int ChildRecordId, string ParentProcessCode, int ParentRecordId, int Depth);
public sealed record TraceDetailRow(string ProcessCode, int RecordId, string BatchRef, string Material, decimal Quantity, string Uom, DateTime CreatedAt, string? Operator);
public sealed record TraceChainResult(List<TraceChainLink> Chain, Dictionary<string, TraceDetailRow> Details);
