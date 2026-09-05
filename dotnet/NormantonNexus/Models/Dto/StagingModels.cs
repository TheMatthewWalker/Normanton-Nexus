namespace NormantonNexus.Models.Dto;

// Staging Post — material requisitions from Production to Stores. Port of
// routes/staging.js + routes/stagingsql.js. Warehouse Sub-phase 7d.

public sealed record StagingMaterialSearchRow(string Material, string MaterialText, string Uom);

public sealed record StagingOpenSummary(int OpenCount, int OverdueCount);

/// <summary>Mirrors stagingsql.js's REQUEST_COLUMNS field-for-field.</summary>
public sealed record StagingRequestRow(
    int RequestId, string? Material, string? MaterialText, string? Uom, decimal QuantityRequested, decimal QuantityDelivered,
    string? RequestUnit, decimal? RequestUnitQty, bool IsNonSap,
    string Location, string? RequestedBatch, DateTime DueAtUtc, string? Notes, string Status,
    string RequestedBy, DateTime RequestedAtUtc, string? CompletedBy, DateTime? CompletedAtUtc,
    string? CancelledBy, DateTime? CancelledAtUtc, DateTime UpdatedAtUtc);

public sealed record StagingRequestDeliveryRow(
    int DeliveryId, int RequestId, decimal QuantityMoved, string? Batch,
    string? SourceStorageType, string? SourceBin, string? DestinationStorageType, string? DestinationBin,
    string? TransferOrderNumber, string DeliveredBy, DateTime DeliveredAtUtc);

public sealed record StagingRequestDetail(StagingRequestRow Request, IReadOnlyList<StagingRequestDeliveryRow> Deliveries);

public sealed record CreateStagingRequestRequest(
    string? Material, string? MaterialText, string? Uom, decimal? QuantityRequested, string? Location,
    string? RequestedBatch, DateTime? DueAtUtc, string? Notes, string? RequestUnit, decimal? RequestUnitQty, bool IsNonSap);

public sealed record StagingStockWarning(decimal AvailableQty, decimal RequestedQty);

public sealed record CreateStagingRequestResult(int RequestId, DateTime DueAtUtc, StagingStockWarning? StockWarning);

public sealed record DeliverStagingRequestRequest(
    decimal Quantity, string? Batch, string? StorageLocation, string? SourceStorageType, string? SourceBin,
    string? DestinationStorageType, string? DestinationBin, string? StockCategory,
    string? SpecialStockIndicator, string? SpecialStockNumber);

/// <summary>
/// "Helper returns a result, controller maps it to the right HTTP status"
/// pattern (CompleteDeliveryGroupResult/DrummingSubmitResult precedent) —
/// Status "REJECTED" is SAP's own semantic rejection of an otherwise-valid
/// call (WM_TO_CREATE_SINGLE/consignment-mb1b returned failure messages,
/// not an HTTP-level error) and needs its Messages riding along in the 422
/// body's `data`; a guard-blocked or genuinely-failed SAP call is thrown as
/// NexusUnprocessableEntityException instead (plain message, no data),
/// matching Node's own two distinct failure shapes exactly (see
/// StagingHelper.DeliverAsync).
/// </summary>
public sealed record DeliverStagingRequestResult(
    string Status, string? Error,
    string? TransferOrderNumber, List<SapReturnMessage> Messages,
    decimal? CumulativeDelivered, decimal? QuantityRequested, bool? MetOrExceeded, bool? WithinTolerance,
    RedrumReversalResult? Redrum);

/// <summary>Public wire DTO mirroring RedrumReversalHelper's own internal Result record field-for-field — that Helper's Result type stays internal (matching every other Helper's internal-static convention), so DeliverStagingRequestResult (a public DTO, since every DTO in this codebase is) maps onto this instead of exposing the internal type directly.</summary>
public sealed record RedrumReversalResult(string Status, string? MaterialDocument, string? ReversalDocument, string? TransferOrderNumber, int? DrummingId, string? Warning, string? Error);

public sealed record StagingKpiOverall(int CompletedCount, int OnTimeCount, decimal? AvgLeadTimeHours);

public sealed record StagingKpiByMaterial(string Material, string? MaterialText, int CompletedCount, int OnTimeCount, decimal? AvgLeadTimeHours);

public sealed record StagingKpiResult(StagingKpiOverall Overall, IReadOnlyList<StagingKpiByMaterial> ByMaterial);

public sealed record StagingBinRestrictionRow(int RestrictionId, string Material, string StorageType, string? Bin, string? Notes, string? CreatedBy, DateTime CreatedAtUtc);

public sealed record StagingBinRestrictionForMaterialRow(int RestrictionId, string Material, string StorageType, string? Bin, string? Notes);

public sealed record CreateBinRestrictionRequest(string Material, string StorageType, string? Bin, string? Notes);

public sealed record BinRestrictionImportRow(string Material, string StorageType, string? Bin, string? Notes);

public sealed record BulkImportBinRestrictionsRequest(List<BinRestrictionImportRow> Records);

public sealed record BinRestrictionImportError(string? Material, string Error);

public sealed record BulkImportBinRestrictionsResult(int Inserted, int Skipped, List<BinRestrictionImportError> Errors);

/// <summary>SapStockRow plus the bin-restriction check the picker view overlays on top — restricted bins are flagged (IsAllowed), not filtered out, so Stores can still see stock that exists in a non-permitted bin rather than wrongly concluding there's none at all.</summary>
public sealed record StagingStockRow(
    string StorageLocation, string StorageType, string Bin, string Material, decimal AvailableQty, string Batch,
    string StockCategory, string SpecialStockInd, string SpecialStockNum, string GrDate, string ProfitCentre, bool IsAllowed);

public sealed record RequestStockResult(IReadOnlyList<StagingStockRow> Stock, bool HasRestrictions, string? RequestedBatch);

public sealed record MaterialRequestUnitRow(int RequestUnitId, string Material, string Unit, decimal ConversionQty);
