namespace NormantonNexus.Models.Dto;

// Production Schedule — shared between Sales and Production department
// pages (Node: routes/productionschedule.js + productionschedulesql.js).
// Views are department-gated "production OR sales"; the comment/ETA edit
// is permission-gated PROD_SCHEDULE_EDIT (a new per-tile code replacing
// the "PROD_SUPERVISOR OR SALES_SUPERVISOR" OR-of-two-legacy-codes gate —
// see the migration for how existing holders of either keep access).

public sealed record ProductionScheduleRow(
    string Customer, string CustomerName, string ReferenceDocument, string Item, string Material, string MaterialText,
    DateTime? RequestDate, decimal OrderQty, string Uom, decimal StockQty, decimal PickedQty,
    decimal? StandardPrice, decimal? Amount, string? Currency, DateTime? DisplayDate,
    string Comment, DateTime? Eta, DateTime? CommentUpdatedUtc, string? CommentUpdatedBy);

public sealed record ProductionArrearsRow(
    string Customer, string CustomerName, string ReferenceDocument, string Item, string Material, string MaterialText,
    DateTime? RequestDate, decimal OrderQty, string Uom, decimal StockQty, decimal PickedQty,
    decimal? StandardPrice, decimal? Amount, string? Currency,
    string Comment, DateTime? Eta, DateTime? CommentUpdatedUtc, string? CommentUpdatedBy);

public sealed record ProductionScheduleListResponse(List<ProductionScheduleRow> Rows, DateTime WindowStart, DateTime WindowEnd);

public sealed record ProductionScheduleCommentSaveRequest(string? Comment, DateTime? Eta);

public sealed record OtifKpiRow(int Year, int Month, int OnTimeCount, int TotalCount, double? OnTimePct);

public sealed record OtifLateRow(
    string ReferenceDocument, string Item, string Customer, string CustomerName, string Material, string MaterialText,
    decimal OrderQty, string Uom, DateTime? DueDate, DateTime? CompletedDate, string? Reason);

public sealed record OtifDiffResult(int Inserted, int Refreshed, int Completed);
