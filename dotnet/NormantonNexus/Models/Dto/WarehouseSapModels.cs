namespace NormantonNexus.Models.Dto;

// Mirrors SapServer's picksheet/LIKP DTOs (Helpers/PicksheetHelpers.cs,
// Helpers/CustomsHelpers.cs there) field-for-field. Every quantity comes
// back as a raw, unparsed string — SapServer's own PicksheetHelpers.
// ParseStockRows/ParseLipsRows pass the RFC_READ_TABLE dump straight
// through with no decimal normalization (confirmed by reading that source
// directly) — the caller is responsible for parsing it, same as Node's own
// parseSapNum. See WarehousePicksheetHelper.ParseSapQuantity for why this
// port's parsing differs from Node's.

public sealed record SapPicksheetStockRequest(List<string> Materials);

public sealed record SapPicksheetBatchRow(
    string Material, string Batch, string StorageType, string Bin, string TotalQty, string AvailableQty,
    string StockCategory, string SpecialStockInd, string SpecialStockNum, string PackagingMaterial, string AllocatedDelivery);

public sealed record SapPicksheetLipsRequest(List<string> Deliveries);

public sealed record SapPicksheetLipsRow(string DeliveryNumber, string ItemNumber, string MaterialNumber, string Quantity);

public sealed record SapLikpRequest(List<string> Deliveries);

public sealed record SapLikpRow(string DeliveryNumber, string Incoterms, string ConsigneeCode, string GoodsIssueDate);

/// <summary>Mirrors SapServer's PicksheetUnstageBatchRequest field-for-field — POST /api/warehouse/picksheet-unstage-batch, reversing a picksheet-stage-batch transfer order.</summary>
public sealed record SapPicksheetUnstageBatchRequest(string Material, string Batch, string StagedBin, string OriginalSourceType, string OriginalSourceBin);

/// <summary>Mirrors SapServer's PicksheetUnstageBatchResponse. The envelope's own top-level Success (not this record's Success field) is what SapServerClient throws on for a genuine 422 rejection — this record's own fields are only inspected for the successful-response detail.</summary>
public sealed record SapPicksheetUnstageBatchResponse(bool Success, string TransferOrderNumber, decimal QuantityMoved, bool NothingToReverse, string? Error, List<SapReturnMessage> Messages);

/// <summary>The subset of a log.PalletPackages row reverseStagedPackage needs — shared by PalletMainHelper (reversing every package on a removed pallet) and PalletPackagesHelper (reversing one deleted package).</summary>
public sealed record StagedPackageInfo(int PalletItemId, string? SapMaterial, string? SapBatch, string? SapDelivery, string? SapSourceStorageType, string? SapSourceBin);

/// <summary>Attempted:false means the row was never staged (no SAP fields recorded — e.g. a manually-typed batch with no SAP match) — nothing to do. Attempted:true/Success:false means SAP rejected the reversal; the caller must not proceed with deleting/removing.</summary>
public sealed record StagedPackageReversalResult(bool Attempted, bool Success, string? Error);
