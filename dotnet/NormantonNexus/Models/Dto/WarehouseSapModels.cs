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
