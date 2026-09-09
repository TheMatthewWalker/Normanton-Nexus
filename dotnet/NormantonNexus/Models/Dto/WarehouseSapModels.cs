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

// ── Delivery completion pipeline (Sub-phase 7c) ─────────────────────────
// Mirrors SapServer's own DTOs field-for-field, confirmed by reading
// WarehouseHelpers.cs/ZdelflagHelpers.cs/GoodsIssueHelper.cs/
// DeliveryChangeHelper.cs directly.

/// <summary>POST /api/warehouse/set-delivery-weight — pushes the real picked/packed gross weight, net weight, and pallet count onto LIKP (transaction ZDEL) once a delivery is marked complete.</summary>
public sealed record SapSetDeliveryWeightRequest(string DeliveryNumber, decimal GrossWeight, decimal NetWeight, int PalletCount);

public sealed record SapSetDeliveryWeightResponse(string Message);

public sealed record SapZdelflagLipsItemRow(string ItemNumber, string Description, string CustomerMaterial, string SalesUnit);

public sealed record SapZbomInfoRequest(List<string> PackagingInstructions);

public sealed record SapZbomInfoRow(string PackagingInstruction, string ComponentMaterial);

/// <summary>One T_DELFLAG row — one per log.PalletPackages row (VHART "SMBX") plus one combined header row per pallet (VHART "PALL"). See DeliveryCompletionHelper.BuildDelflagRows for the full field-by-field construction, mirrored from Node's runZdelflagMaintenance exactly.</summary>
public sealed record SapDelflagRowRequest(
    string Vbeln, string Posnr, string Charg, string Kunnr, string Empst, string Werks,
    decimal Ntgew, decimal Brgew, string Kdmat, decimal Lfimg, string Eikto, string Arktx, string Matnr,
    string Budat, string Packid, string Boxes, string Pallet, string Vhart, string SmbxMatnr, string PallMatnr,
    string Mtart, string Smbxhu, string Done, bool PrintPalletLabel, bool PrintBoxLabel);

/// <summary>One T_DELPACK row per (package, ZBOM_INFO~IDNRK) pair.</summary>
public sealed record SapDelpackRowRequest(string Packid, string PallMatnr, decimal Menge, string Meins, decimal Tarewei, string Gewei);

public sealed record SapMaintainZdelflagRequest(List<SapDelflagRowRequest> DelflagRows, List<SapDelpackRowRequest> DelpackRows);

public sealed record SapMaintainZdelflagResponse(string Rc, List<SapReturnMessage> Messages);

/// <summary>
/// POST /api/warehouse/goods-issue (BAPI_OUTB_DELIVERY_CONFIRM_DEC).
/// Confirmed live (2026-08-28) that POST_GI_FLG alone isn't enough — SAP
/// rejects with "Delivery has not yet been put away / picked (completely)"
/// unless Items also carries each real delivery item's picked quantity.
/// </summary>
public sealed record SapGoodsIssueRequest(string DeliveryNumber, List<SapGoodsIssueItem> Items, bool TestRun = false);

public sealed record SapGoodsIssueItem(string ItemNumber, decimal Quantity, string? BaseUom = null);

public sealed record SapGoodsIssueResponse(string DeliveryNumber, bool Success, List<SapReturnMessage> Messages);

/// <summary>
/// POST /api/warehouse/delivery-change (BAPI_OUTB_DELIVERY_CHANGE) — brings
/// SAP's own delivery quantity in line with what was actually picked, for
/// an item within 10% but not an exact match. UNVERIFIED for this specific
/// call site: SapServer's own DeliveryChangeItem.BaseUom has no fallback
/// default (SapServer's BuildDeliveryChangeRequest does `item.BaseUom ?? ""`
/// — a genuinely blank BASE_UOM if never supplied), and SapServer's own
/// live diagnosis notes confirm BASE_UOM alone was insufficient without
/// SalesUnit/FactUnitNom/FactUnitDenom also being right — none of which
/// Node's own sync-delivery-quantities route currently sends (it only ever
/// sent ItemNumber/Material/Quantity). Unlike the Goods Issue fix above,
/// this was NOT confirmed working via a live curl test, so it's ported
/// exactly matching Node's current (possibly still-incomplete) behavior
/// rather than guessed at — flagged here for the same kind of deliberate
/// verification the Goods Issue contract just got.
/// </summary>
public sealed record SapDeliveryChangeRequest(string DeliveryNumber, List<SapDeliveryChangeItem> Items, bool TestRun = false);

public sealed record SapDeliveryChangeItem(string ItemNumber, string? Material, decimal Quantity);

public sealed record SapDeliveryChangeResponse(string DeliveryNumber, bool Success, List<SapReturnMessage> Messages);

/// <summary>Mirrors SapServer's CreateTransferOrderRequest field-for-field — POST /api/warehouse/transfer-order (LT01/LT04). Used both by the picksheet-stage-batch flow (a later slice) and RedrumReversalHelper's WM tidy-up leg (SA/PTFE -> the outside-WM holding bin).</summary>
public sealed record CreateTransferOrderRequest(
    string StorageLocation, string Material, decimal Quantity, string SourceType, string SourceBin, string DestinationType, string DestinationBin,
    string? Batch = null, string? StockCategory = null, string? SpecialStockIndicator = null, string? SpecialStockNumber = null);

public sealed record CreateTransferOrderResponse(string TransferOrderNumber, bool Success, List<SapReturnMessage> Messages);

/// <summary>Mirrors SapServer's ConsignmentMb1bRequest field-for-field — POST /api/warehouse/consignment-mb1b (MB1B + LT01 non-consign/consign pair). Used when consignment stock (LQUA-SOBKZ 'K') moves into a production bin — needs a real goods-issue-from-consignment posting, not just a bin-to-bin transfer order.</summary>
public sealed record ConsignmentMb1bRequest(
    string Material, decimal Quantity, string Header, string SpecialStockNumber, string StorageLocation,
    string SourceType, string SourceBin, string DestinationType, string DestinationBin, string DeliveryNote = "", bool TestRun = false);

/// <summary>Mirrors SapServer's ConsignmentMb1bResponse — Success reflects whether all three legs (MB1B goods issue, then the two LT01 transfer postings) actually succeeded, not just that the RFC calls themselves didn't throw.</summary>
public sealed record ConsignmentMb1bResponse(bool Success, string Mb1bMessage, string ToNonConsignMessage, string ToConsignMessage);

/// <summary>Mirrors SapServer's StockQuery — [FromUri] query-string parameters for GET /api/warehouse/stock, sent as an actual query string (QueryHelpers.AddQueryString), not a JSON body — that endpoint model-binds from the URL, unlike find-cost-collector/check-profit-centre's [HttpGet]+[FromBody] pattern elsewhere in this port.</summary>
public sealed record SapStockQuery(string? Material = null, string? StorageType = null, string? ExcludeStorageType = null, string? Bin = null, string? Batch = null, string? StorageLocation = null, string? StockCategory = null, string? ProfitCentre = null, int RowCount = 9999);

/// <summary>Mirrors SapServer's StockRow field-for-field — one LQUA quant.</summary>
public sealed record SapStockRow(string StorageLocation, string StorageType, string Bin, string Material, decimal AvailableQty, string Batch, string StockCategory, string SpecialStockInd, string SpecialStockNum, string GrDate, string ProfitCentre);
