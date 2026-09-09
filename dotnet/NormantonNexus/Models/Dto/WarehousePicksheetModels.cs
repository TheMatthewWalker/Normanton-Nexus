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

/// <summary>
/// GET :deliveryId/pallets — pallets picked for a delivery (includes
/// palletID for the builder). Widened to also include pallets OWNED (via
/// log.DeliveryLink) by any picksheet linked to this one, matching Node's
/// own query exactly — a delivery with no links just gets an empty IN
/// subquery, byte-for-byte equivalent to the unwidened form. Used by both
/// the pallet builder (not yet ported) and the outbound Shipment Details
/// modal's read-only Packaging card.
/// </summary>
public sealed record DeliveryPalletRow(
    long PalletId, string? PalletType, bool PalletFinish, decimal? PalletLength, decimal? PalletWidth, decimal? PalletHeight,
    decimal? GrossWeight, decimal? PackagingWeight, decimal? PalletVolume, string? PalletLocation, string? PalletCategory, DateTime? PalletCreationDate);

/// <summary>GET available-for-shipment/:customerId — unshipped, completed deliveries for one customer, the "Add Deliveries" picker inside the outbound Shipment Details modal's Modify Deliveries panel.</summary>
public sealed record AvailableForShipmentRow(
    long DeliveryId, long? CustomerId, DateTime? DispatchDate, DateTime? DeliveryDate, DateTime? CompletionDate,
    string? DeliveryService, string? PicksheetComment, string? Incoterms,
    decimal NetWeight, decimal GrossWeight, decimal PalletCount, decimal DeliveryVolume,
    string? DestinationName, string? DefaultIncoterms);

/// <summary>
/// GET completed-unshipped — Logistics' Create Outbound Shipment picker.
/// Completed, not-cancelled, not-in-packaging-holding deliveries with no
/// row in log.ShipmentLink yet (never shipped). Mirrors Node's own query
/// field-for-field, including the customer's own email address list
/// (STUFF/FOR XML PATH concatenation — this app's SQL Server 2005-
/// compatible string-aggregation idiom, matching every other place in
/// this migration that needed one) even though no confirmed frontend
/// caller reads it yet — cheap to keep, and a generic "picker row" is
/// exactly the kind of read a not-yet-built follow-up (e.g. an inline
/// "email this customer" action) would want more of, not less.
/// </summary>
public sealed record CompletedUnshippedRow(
    long DeliveryId, long? CustomerId, DateTime? DispatchDate, DateTime? DeliveryDate, DateTime? CompletionDate,
    string? DeliveryService, string? PicksheetComment, int? DeliveryPriority,
    decimal NetWeight, decimal GrossWeight, decimal PalletCount, decimal DeliveryVolume,
    string? DestinationName, string? DestinationStreet, string? DestinationCity, string? DestinationPostCode, string? DestinationCountry,
    string? DefaultIncoterms, string? DefaultForwarder, string? Incoterms, string? Address);

/// <summary>POST / (Add Picksheet tile) — manual single-delivery entry, port of deliverymain.js's own field list exactly (completionStatus/deliveryCancelled default to false, deliveryPriority to 0, matching Node's `?? 0`/`?? 0` coalesces).</summary>
public sealed record CreateDeliveryMainRequest(
    long DeliveryId, long? CustomerId, DateTime? DispatchDate, DateTime? DeliveryDate, DateTime? CompletionDate,
    bool CompletionStatus, string? OperatorName, string? SupervisorName, decimal? NetWeight, decimal? GrossWeight,
    decimal? PalletCount, decimal? DeliveryVolume, string? PicksheetComment, bool DeliveryCancelled, int DeliveryPriority,
    string? DeliveryService, string? Incoterms);

/// <summary>POST /bulk (Bulk CSV Import tile) — one row per record; a duplicate deliveryID is silently skipped (WHERE NOT EXISTS), not an error, matching Node's own inserted/skipped counters exactly.</summary>
public sealed record BulkImportDeliveryRow(
    long DeliveryId, long? CustomerId, DateTime? DispatchDate, DateTime? DeliveryDate,
    string? DeliveryService, int DeliveryPriority, string? PicksheetComment, string? Incoterms);

public sealed record BulkImportDeliveriesRequest(List<BulkImportDeliveryRow> Records);

public sealed record BulkImportErrorRow(long DeliveryId, string Error);

public sealed record BulkImportDeliveriesResult(int Inserted, int Skipped, List<BulkImportErrorRow> Errors);

/// <summary>One SAP batch found for a required material, classified for the picking panel — allowed/group/reason mirror getRemainingRequiredMaterials's own allocation/packaging-mismatch precedence exactly.</summary>
public sealed record PicksheetMaterialBatch(
    string Batch, string? StorageType, string? Bin, decimal TotalQty, decimal AvailableQty,
    string? StockCategory, string? PackagingMaterial, string? AllocatedDelivery, bool Allowed, string Group, string? Reason);

public sealed record PicksheetRequiredMaterial(
    string Material, decimal RequiredQty, string? DeliveryItem, List<PicksheetMaterialBatch> Batches,
    string? ProfitCentre, bool UsesContainerPacking);

public sealed record PicksheetMaterialsResult(long? CustomerId, List<PicksheetRequiredMaterial> Materials);
