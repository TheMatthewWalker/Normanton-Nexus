namespace NormantonNexus.Models.Dto;

// Quality department — Stock Information (Display/Block/Unblock Stock) +
// Traceability Concessions. Ported from routes/quality.js +
// routes/productionnexus.js's concession endpoints (the concessions tile
// lives on the Quality page but its data is Production-domain — see
// QualityHelper's own comments) and private/js/quality.js.

/// <summary>One LQUA row for warehouse 312 — every stock category, not just blocked (see QualityHelper.DisplayStockAsync's own comments on why).</summary>
public sealed record StockRow(
    string StorageLocation, string StorageType, string Bin, string Material,
    string AvailableQty, string Batch, string StockCategory, string SpecialStockInd, string SpecialStockNum)
{
    public bool IsBlocked => StockCategory.Trim() == "S";
}

/// <summary>Minimal shape of SapServer's generic RfcRequest (Models/RfcModels.cs there) — only the fields DisplayStockAsync's fixed ZRFC_READ_TABLES call needs.</summary>
public sealed record RfcExecuteRequest(
    string FunctionName,
    Dictionary<string, object?> ImportParameters,
    Dictionary<string, List<Dictionary<string, object?>>> InputTables,
    Dictionary<string, List<Dictionary<string, object?>>> InputTablesItems,
    List<string> ExportParameters,
    Dictionary<string, List<string>> OutputTables);

/// <summary>Narrowed to what DisplayStockAsync actually reads back — every row of the "data_display" output table is just a single "WA" (pipe-delimited work-area) string column for ZRFC_READ_TABLES.</summary>
public sealed record RfcExecuteResponse(Dictionary<string, List<Dictionary<string, string>>> Tables);

/// <summary>Mirrors SapServer's QualityMb1bRequest (Models/Bapi/QualityModels.cs there) field-for-field. Username is always set server-side from the calling user, never from the client.</summary>
public sealed record QualityMb1bRequest(
    string Material, decimal Quantity, string Header, string SpecialStockIndicator,
    string Batch, string StorageLocation, string BinType, string Bin, string Username);

/// <summary>Mirrors SapServer's QualityMb1bResponse exactly.</summary>
public sealed record QualityMb1bResponse(bool Success, string Mb1bMessage, string ToNonBlockedMessage, string ToBlockedMessage);

public sealed record BlockUnblockRequest(
    string Material, decimal Quantity, string Header, string? SpecialStockIndicator,
    string? Batch, string StorageLocation, string? BinType, string? Bin, string? SpecialStockNumber);

/// <summary>
/// One row of a bulk block/unblock batch. Property names are clean camelCase
/// (not Node's raw table-column names like "Storage Loc") since both this
/// DTO's producer (wwwroot/js/quality/stock.js) and consumer are new code
/// written together in this migration — no compatibility reason to keep
/// Node's awkward space-containing JS object keys.
/// </summary>
public sealed record BulkStockRow(
    string Material, string Quantity, string? Batch, string StorageLocation,
    string? StorageType, string? StorageBin, string? SpecialStockIndicator, string? SpecialStockNumber);

public sealed record BulkBlockUnblockRequest(List<BulkStockRow> Rows, string Direction, string? Header);

/// <summary>One Server-Sent Event frame written by QualityController.Bulk.</summary>
public sealed record BulkProgressEvent(string Type, int? Total = null, int? Done = null, bool? Success = null, string? Material = null, string? Message = null, string? Error = null);

public sealed record ConcessionRow(
    int ConcessionId, string ProcessCode, int RecordId, string ParentProcessCode, int ParentRecordId,
    string Component, string ActualMaterial, string Reason, string? RaisedByUsername, DateTime RaisedAt,
    string Status, string? ReviewedByUsername, DateTime? ReviewedAt, string? ReviewNotes);

public sealed record ConcessionReviewRequest(string? Notes);
