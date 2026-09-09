namespace NormantonNexus.Models.Dto;

// Scrap Reversal — search + missed-reversals + reverse action, port of the
// corresponding section of routes/productionnexus.js. Reverses
// prod.ScrapMaterialDocuments (MBST) — distinct from SAP Reversals (the
// fifth Sub-phase 6b slice, which reverses prod.SAPPostings/backflush
// documents via MF41 instead).

public sealed record ScrapDocSearchRow(
    int ScrapDocumentId, int ScrapId, string MaterialDocument, bool IsReversed, string? ReversalDocument, DateTime PostedAt,
    string ProcessCode, int ProcessRecordId, decimal Quantity, string UnitOfMeasure,
    string? ReasonCode, string? ReasonDescription, string? PostedBy, string? BatchRef, string? Material, bool BackflushReversed);

public sealed record ScrapReversalSearchQuery(
    string? MaterialDocument, string? BatchRef, string? Material, string? ProcessCode,
    string? DateFrom, string? DateTo, string? Operator);

public sealed record ScrapReversalReverseRequest(int ScrapDocumentId, string MaterialDocument);

public sealed record ScrapReversalReverseResult(string? ReversalDocument, bool Synced);

public sealed record ScrapReversalBulkRequest(ScrapReversalReverseRequest[] Items);

public sealed record ScrapReversalBulkItemResult(int ScrapDocumentId, string MaterialDocument, bool Success, string? Error, string? ReversalDocument, bool Synced);
