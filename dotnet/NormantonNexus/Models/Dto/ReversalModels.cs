namespace NormantonNexus.Models.Dto;

// SAP Reversals — port of the Reversal section of routes/productionnexus.js
// (search/by-batch/find/execute/mark/bulk). Distinct from Scrap Reversal (a
// separate later Sub-phase 6b slice, built on prod.ScrapMaterialDocuments —
// this cluster reverses prod.SAPPostings/backflush documents themselves).

public sealed record SapPostingRow(
    int SapPostingId, string ProcessCode, int ProcessRecordId, string PostingType,
    decimal Quantity, string UnitOfMeasure, string? MaterialDocumentSap, DateTime PostedAt, bool IsReversed);

public sealed record SapPostingByBatchRow(
    int SapPostingId, string PostingType, string? MaterialDocumentSap, decimal Quantity, string UnitOfMeasure,
    bool IsReversed, string? ReversalDocumentSap, DateTime PostedAt, DateTime? ReversedAt, string? PostedBy);

public sealed record ReversalFindQuery(string? Material, string? DateFrom, string? DateTo, string? Operator);

public sealed record SapPostingFindRow(
    int SapPostingId, string ProcessCode, int ProcessRecordId, string PostingType, decimal Quantity, string UnitOfMeasure,
    string? MaterialDocumentSap, DateTime PostedAt, bool IsReversed, string? ReversalDocumentSap, DateTime? ReversedAt,
    string? PostedBy, string? Material);

/// <summary>PATCH /reversal/:sapPostingId — records a reversal that already happened in SAP (e.g. via MBST directly), not ported to any frontend page today (Node's own UI doesn't call this route either — kept for API parity/future direct callers, same as Node itself).</summary>
public sealed record ReversalMarkRequest(string ReversalDocumentSap);

/// <summary>POST /reversal/execute — reverses a single backflush document via SapServer's MF41 wrapper. Like ReversalMarkRequest, not called by Node's own frontend (only the bulk path is) — kept for API parity.</summary>
public sealed record ReversalExecuteRequest(string MaterialDocument);

public sealed record ReversalExecuteResult(string? ReversalDocument, string OriginalDocument);

public sealed record ReversalBulkRequest(string[] MaterialDocuments);

public sealed record ReversalBulkItemResult(string MaterialDocument, bool Success, string? Error, string? ReversalDocument, bool Synced);
