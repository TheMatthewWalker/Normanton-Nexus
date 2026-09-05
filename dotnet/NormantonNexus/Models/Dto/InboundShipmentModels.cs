namespace NormantonNexus.Models.Dto;

// ── Logistics Sub-phase 8b.4: Inbound shipment tracking ────────────────────
// (haulier/mode of transport/tracking numbers for orders that travel via a
// haulier) — see sql/migrate_order_shipments.sql for the full reasoning.
// Filesystem-only document handling here; the real-SAP goods-receipt write
// (Mark Received/Undo Received) is deferred to 8b.7.

public sealed record OrderShipmentListRow(
    long ShipmentId, string ShipmentReference, DateTime? DispatchDate, DateTime? ExpectedEta,
    string? Haulier, long? ForwarderId, string? ModeOfTransport, string? TrackingNumber, string? BillOfLading, string? ContainerNumber,
    string? Notes, DateTime? ReceivedAtUtc, string? ReceivedBy, DateTime? CancelledAtUtc, string? CancelledBy,
    DateTime CreatedAtUtc, DateTime UpdatedAtUtc, bool IsManual, string? OriginName,
    int OrderCount, string? Suppliers, string? OrderMaterials, string? ManualMaterials, string? PoNumbers, string? SupplierReferences);

/// <summary>Same shape for both POST /order-suggestions/shipments (from selected tracked orders) and its manual-shipment sibling below shares most fields.</summary>
public sealed record CreateOrderShipmentRequest(
    DateTime? DispatchDate, DateTime? ExpectedEta, string? Haulier, long? ForwarderId, string? ModeOfTransport,
    string? TrackingNumber, string? BillOfLading, string? ContainerNumber, string? Notes, List<long>? SuggestionIds);

public sealed record CreateOrderShipmentResult(long ShipmentId, string ShipmentReference, int OrderCount);

public sealed record CreateManualOrderShipmentRequest(
    long? OriginDestinationId, long? ForwarderId, string? ModeOfTransport, DateTime? DispatchDate, DateTime? ExpectedEta,
    string? TrackingNumber, string? Notes, decimal? Price, string? CostCentre, string? Tier);

public sealed record InsertedCostLineResult(long CostId, string ElementCode);

public sealed record CreateManualOrderShipmentResult(long ShipmentId, string ShipmentReference, InsertedCostLineResult? Cost);

public sealed record OrderShipmentDetailOrderRow(
    long SuggestionId, string Material, string? MaterialText, string? Uom, string VendorName, string? OrderMoqUom,
    decimal OrderQty, decimal? ReceivedQty, string Status, string? SupplierReference, string? PoNumber, string? PoItemNumber,
    string? Notes, string? SapMaterialDocument, string? SapGrError, bool? SapGrSkipped);

public sealed record ManualInboundItemRow(long ItemId, long ShipmentId, string? Material, string? Description, decimal Quantity, string? UnitOfMeasure, DateTime CreatedAtUtc, string? CreatedBy);

public sealed record OrderShipmentDetailResult(
    long ShipmentId, string ShipmentReference, DateTime? DispatchDate, DateTime? ExpectedEta,
    string? Haulier, long? ForwarderId, string? ModeOfTransport, string? TrackingNumber, string? BillOfLading, string? ContainerNumber,
    string? Notes, DateTime? ReceivedAtUtc, string? ReceivedBy, DateTime? CancelledAtUtc, string? CancelledBy,
    DateTime CreatedAtUtc, DateTime UpdatedAtUtc, bool IsManual, long? OriginDestinationId, string? OriginName,
    IReadOnlyList<OrderShipmentDetailOrderRow> Orders, IReadOnlyList<ManualInboundItemRow> ManualItems);

/// <summary>ShipmentReference is intentionally excluded — auto-generated at creation and permanent, never user-editable.</summary>
public sealed record UpdateOrderShipmentRequest(
    DateTime? DispatchDate, DateTime? ExpectedEta, string? Haulier, long? ForwarderId, string? ModeOfTransport,
    string? TrackingNumber, string? BillOfLading, string? ContainerNumber, string? Notes);

public sealed record AddManualInboundItemRequest(string? Material, string? Description, decimal? Quantity, string? UnitOfMeasure);

public sealed record CancelOrderShipmentResult(int UnlinkedCount);

public sealed record AssignOrderShipmentRequest(long? ShipmentId);

public sealed record InboundShipmentDocumentFileInfo(string FileName, long SizeBytes, DateTime ModifiedAtUtc, string DownloadUrl);

public sealed record InboundShipmentDocumentFolderResult(string? SupplierName, IReadOnlyList<InboundShipmentDocumentFileInfo> Files, string FolderPath);

public sealed record UploadedInboundDocumentResult(string FileName, long SizeBytes, string DownloadUrl);
