namespace NormantonNexus.Models.Dto;

// Open Picksheets, Packaging Holding, picksheet materials/stock panel,
// linked picksheets, and picksheet link-search — port of the read-only
// half of routes/deliverymain.js's picksheet-building section. The
// write half (link/unlink, stage-batch, comment, cancel-picksheet) is
// Sub-phase 7b, alongside the pallet/package builder it feeds.

/// <summary>
/// GET /:deliveryId — Node does a bare SELECT * and returns the raw
/// recordset; the only field any confirmed frontend caller actually reads
/// off it (warehouse.js's pallet-builder loaders and the Create Shipment
/// comment prompt) is picksheetComment, but the full known column set
/// (from deliverymain.js's own POST insert list, plus the two extra
/// columns confirmed elsewhere in this file's other queries) is kept here
/// rather than trimmed to just that one field, since a generic "get
/// delivery by ID" read is exactly the kind of endpoint a not-yet-built
/// page is likely to need more of later.
/// </summary>
public sealed record DeliveryMainRow(
    long DeliveryId, long? CustomerId, DateTime? DispatchDate, DateTime? DeliveryDate, DateTime? CompletionDate,
    bool CompletionStatus, string? OperatorName, string? SupervisorName, decimal? NetWeight, decimal? GrossWeight,
    decimal? PalletCount, decimal? DeliveryVolume, string? PicksheetComment, bool DeliveryCancelled, int? DeliveryPriority,
    string? DeliveryService, string? Incoterms, bool PendingPackagingData, DateTime? MovedToHoldingAtUtc);

public sealed record OpenPicksheetRow(
    long DeliveryId, long? CustomerId, string? DestinationName, DateTime? DispatchDate,
    string? DeliveryService, string? PicksheetComment, int? DeliveryPriority, string? Incoterms);

/// <summary>Deliveries the SAP sync found completed outside Nexus, waiting for someone to confirm their real packaging data via the normal pallet builder.</summary>
public sealed record PackagingHoldingRow(
    long DeliveryId, long? CustomerId, string? DestinationName, DateTime? DispatchDate,
    string? DeliveryService, string? PicksheetComment, int? DeliveryPriority, string? Incoterms, DateTime? MovedToHoldingAtUtc);

public sealed record LinkedPicksheetRow(long DeliveryId, long? CustomerId, string? DestinationName, bool CompletionStatus, DateTime? DispatchDate);

public sealed record LinkSearchRow(long DeliveryId, long? CustomerId, string? DestinationName, DateTime? DispatchDate);

/// <summary>One SAP batch found for a required material, classified for the picking panel — allowed/group/reason mirror getRemainingRequiredMaterials's own allocation/packaging-mismatch precedence exactly.</summary>
public sealed record PicksheetMaterialBatch(
    string Batch, string? StorageType, string? Bin, decimal TotalQty, decimal AvailableQty,
    string? StockCategory, string? PackagingMaterial, string? AllocatedDelivery, bool Allowed, string Group, string? Reason);

public sealed record PicksheetRequiredMaterial(
    string Material, decimal RequiredQty, string? DeliveryItem, List<PicksheetMaterialBatch> Batches,
    string? ProfitCentre, bool UsesContainerPacking);

public sealed record PicksheetMaterialsResult(long? CustomerId, List<PicksheetRequiredMaterial> Materials);
