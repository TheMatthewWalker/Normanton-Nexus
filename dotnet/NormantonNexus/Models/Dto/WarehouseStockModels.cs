namespace NormantonNexus.Models.Dto;

// Backs the "Stock Management" / "Transfer Orders" / "Transfer Requirements
// (LT04)" Warehouse tiles — Phase 10's frontend catch-up found these had
// never been ported at all (Phase 7's own status notes flagged "sap.js's
// general Stock Transfer tool... NOT scoped into 7a-7d" but this was never
// picked back up). Every one of these mirrors SapServer's own
// Models/Bapi/WarehouseModels.cs field-for-field — confirmed by reading that
// file directly, same "read the real source, don't guess" discipline as
// every other SapServer-DTO-mirroring file in this app
// (WarehouseSapModels.cs, StagingModels.cs, etc.).

public sealed record StockQuery(
    string? Material, string? StorageType, string? ExcludeStorageType, string? Bin, string? Batch,
    string? StorageLocation, string? StockCategory, string? ProfitCentre, int RowCount = 9999);

/// <summary>Named WarehouseStockRow, not StockRow — QualityModels.cs already has its own, differently-shaped StockRow for a different SapServer read (Quality's Display Stock tile).</summary>
public sealed record WarehouseStockRow(
    string StorageLocation, string StorageType, string Bin, string Material, decimal AvailableQty,
    string Batch, string StockCategory, string SpecialStockInd, string SpecialStockNum, string GrDate, string ProfitCentre);

public sealed record OpenTransferRequirementsQuery(string? MrpController, string? Material, string? StorageLocation, string? CreatedBy);

public sealed record OpenTransferRequirementRow(
    string TrNumber, string Material, string StorageLocation, decimal Quantity, string Uom, string MrpController,
    string DocumentText, string MaterialDocument, string CreatedBy, string CreatedDate, string CreatedTime, string MovementType, string Batch);

/// <summary>
/// StorageLocation is NOT part of SapServer's own CreateLt04Request shape
/// (LT04 has no such field) — mirrors Node's own routes/sap.js, which
/// accepts it purely to run the stock-count transfer guard (the frontend
/// already has it on hand from the open-TR row this action was launched
/// from) and strips it before forwarding to SapServer. Older/unaware
/// callers that omit it simply skip the guard rather than failing closed,
/// same as Node.
/// </summary>
public sealed record CreateLt04Request(
    string TrNumber, string Material, decimal Quantity, string DestinationType, string DestinationBin,
    string PalletOrBatch, string? Reference, string? StorageLocation = null);

public sealed record DeleteTrRequest(string TrNumber);

public sealed record TrCleanupCandidateRow(
    string TrNumber, string Material, string Batch, string StorageLocation, decimal Quantity, string Uom,
    string MrpController, string[] Reasons);

// BdcResponse — the response shape for both create-lt04 and delete-tr (each
// a single BDC call with one MESSG result) — reuses the existing record
// already defined in ProductionSapModels.cs (identical shape, same
// ProductionController.Backflush convention) rather than duplicating it.

/// <summary>POST transfer-order-bulk / create-lt04-bulk request — mirrors Node's `{ items: [...] }` shape (routes/sap.js's own transfer-order-bulk/create-lt04-bulk handlers).</summary>
public sealed record BulkTransferOrderRequest(List<CreateTransferOrderRequest> Items);

public sealed record BulkCreateLt04Request(List<CreateLt04Request> Items);

/// <summary>One item's outcome from a bulk call — success/data on success, error message on failure, matching Node's per-item try/catch (one failure must never abort the rest — Promise.all over independently-caught promises, not a single all-or-nothing call).</summary>
public sealed record BulkItemResult<T>(bool Success, T? Data, string? Error);
