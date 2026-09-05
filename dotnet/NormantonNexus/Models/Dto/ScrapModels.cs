namespace NormantonNexus.Models.Dto;

// Scrap approve/reject/retry/queue — port of the scrap-management section of
// routes/productionnexus.js (summary, failed, entries, pending, retry,
// approve, reject, documents). Distinct from Scrap Reversal (a later
// Sub-phase 6b slice, built on prod.ScrapMaterialDocuments.IsReversed) and
// from per-process entry-time scrap recording (MetreProcessHelper.
// RecordEntryScrapAsync — this cluster only covers *supervisor* review of
// already-recorded prod.ScrapEntries rows).

public sealed record ScrapSummaryRow(string ProcessCode, string? ReasonCode, string? ReasonDescription, string UnitOfMeasure, int EntryCount, decimal TotalScrap);

public sealed record ScrapFailedRow(
    int ScrapId, string ProcessCode, int ProcessRecordId, int ReasonId, string ReasonCode, string ReasonDescription,
    decimal Quantity, string UnitOfMeasure, DateTime EnteredAt, string? SapErrorMessage, DateTime? ApprovedAt,
    string? EnteredBy, string? BatchRef, string? Material);

public sealed record ScrapRetryRequest(decimal? Quantity, int? ReasonId);

public sealed record ScrapRetryResult(IReadOnlyList<string> MaterialDocuments);

public sealed record ScrapDocumentRef(string? MaterialDocument, bool IsReversed, string? ReversalDocument);

public sealed record ScrapEntryRow(
    int ScrapId, string ProcessCode, int ProcessRecordId, string? ReasonCode, string? ReasonDescription,
    decimal Quantity, string UnitOfMeasure, DateTime EnteredAt, string? Notes,
    bool IsApproved, bool SapPosted, string? SapMaterialDocument, string? SapErrorMessage, bool IsReversed,
    string? EnteredBy, string? BatchRef, string? Material, IReadOnlyList<ScrapDocumentRef> MaterialDocuments);

public sealed record ScrapPendingRow(
    int ScrapId, string ProcessCode, int ProcessRecordId, string ReasonCode, string ReasonDescription,
    decimal Quantity, string UnitOfMeasure, DateTime EnteredAt, string? Notes,
    string? EnteredBy, string? BatchRef, string? Material);

public sealed record ScrapBulkRequest(int[] ScrapIds);

public sealed record ScrapBulkItemResult(int ScrapId, bool Success, string? Error, IReadOnlyList<string>? MaterialDocuments);

public sealed record ScrapDocumentRow(
    int ScrapDocumentId, string? MaterialDocument, string? SapType, string? MessageClass, string? MessageNumber, string? SapMessage,
    DateTime PostedAt, int? PostedByUserId, bool IsReversed, string? ReversalDocument, DateTime? ReversedAt, int? ReversedByUserId);

public sealed record ScrapReasonRow(int ReasonId, string ReasonCode, string ReasonDescription, string? AppliesTo);
