namespace NormantonNexus.Models.Dto;

// Logistics Sub-phase 8a.1 — Shipping lifecycle core. Port of the
// non-PDF/non-SMTP/non-customs/non-cost-posting slice of
// routes/shipmentmain.js. See dotnet/CLAUDE.md's Phase 8 section for the
// full sub-slice breakdown (8a.2 manual cargo/documents, 8a.3 PDF
// generation, 8a.4 SMTP collection email, 8a.5 customs/cost-posting).

/// <summary>Full log.ShipmentMain row (SELECT sm.* shape) plus the forwarder name/mode/plannedMovement columns every read in this slice computes alongside it.</summary>
public sealed record ShipmentRow(
    long ShipmentId, long? OriginId, string? OriginName, string? OriginStreet, string? OriginCity, string? OriginPostCode, string? OriginCountry,
    long? DestinationId, string? DestinationName, string? DestinationStreet, string? DestinationCity, string? DestinationPostCode, string? DestinationCountry,
    decimal? NetWeight, decimal? GrossWeight, decimal? PalletCount, decimal? ShipmentVolume,
    DateTime? PlannedCollection, DateTime? ActualCollection, bool CollectionStatus,
    long? ForwarderId, string? TrackingNumber, string? IncoTerms, bool CustomsRequired, bool CustomsComplete, bool ShipmentCancelled,
    DateTime? PlannedDelivery, DateTime? ActualDelivery, bool DeliveryStatus, bool BookingStatus, string? CustomsId, bool IsManual,
    string? ForwarderName, string? ForwarderMode, DateTime? PlannedMovement);

public sealed record BulkShipmentIdsRequest(List<long> ShipmentIds);

public sealed record MarkCollectedBulkRequest(List<long> ShipmentIds, string? Description);

public sealed record BulkActionOutcome(List<long> Completed, List<BulkActionFailure> Failed);

public sealed record BulkActionFailure(long ShipmentId, string Error);

public sealed record UpdatePlannedCollectionRequest(List<long> ShipmentIds, DateTime Date);

public sealed record ShipmentEventEntry(long ShipmentId, string Category, string Description);

public sealed record WriteShipmentEventsRequest(List<ShipmentEventEntry> Events);

public sealed record ShipmentEventRow(int EventId, long ShipmentId, string EventCategory, string EventDescription, DateTime TimeStamp);

public sealed record MarkDeliveredRequest(DateTime? ActualDelivery);

public sealed record MarkDeliveredBulkRequest(List<long> ShipmentIds, DateTime? ActualDelivery);

/// <summary>One shipment's booking confirmation — mirrors Node's normalizeShipmentUpdates shape exactly. SkipCost=true means don't create a ShipmentCost row at all (a booking with no agreed freight cost yet).</summary>
public sealed record MarkBookedShipmentUpdate(
    long ShipmentId, string? TrackingNumber, DateTime? PlannedCollection, DateTime? PlannedDelivery,
    long? ForwarderId, string? ForwarderMode, decimal? ExpectedCost, string? CostCenter, string? ElementCode,
    bool SkipCost, decimal? CustomsCost);

/// <summary>Either Shipments (per-shipment booking details, the real UI path) or ShipmentIds (bare bulk confirm, no cost rows) is populated — mirrors Node's own two-shape branch in POST /mark-booked.</summary>
public sealed record MarkBookedRequest(List<MarkBookedShipmentUpdate>? Shipments, List<long>? ShipmentIds);

public sealed record MarkBookedResult(int Updated);

public sealed record CreateFromDeliveriesRequest(
    List<long> DeliveryIds, string? DestinationName, string? DestinationStreet, string? DestinationCity, string? DestinationPostCode, string? DestinationCountry,
    DateTime? PlannedCollection, DateTime? ActualCollection, bool CollectionStatus, long? ForwarderId, string? TrackingNumber,
    string? IncoTerms, bool CustomsRequired, bool CustomsComplete, bool ShipmentCancelled);

public sealed record CreateShipmentResult(long ShipmentId, string ShipmentRef, int LinkedDeliveries, bool CanSendEmail, string FolderPath, ShipmentRow Shipment);

public sealed record CreateManualShipmentRequest(
    long DestinationId, string? DestinationName, string? DestinationStreet, string? DestinationCity, string? DestinationPostCode, string? DestinationCountry,
    DateTime? PlannedCollection, long? ForwarderId, string? IncoTerms, bool CustomsRequired, bool CustomsComplete);

public sealed record CreateManualShipmentResult(long ShipmentId, string ShipmentRef, ShipmentRow Shipment);

public sealed record ShipmentDeliveryRow(
    long DeliveryId, long? CustomerId, string? DeliveryService, string? PicksheetComment,
    decimal NetWeight, decimal GrossWeight, decimal PalletCount, decimal DeliveryVolume, string? DestinationName);

public sealed record ShipmentDetailResult(ShipmentRow Shipment, IReadOnlyList<ShipmentDeliveryRow> Deliveries);

public sealed record AddDeliveriesToShipmentRequest(List<long> DeliveryIds);

public sealed record RemoveDeliveryResult(bool Cancelled);

public sealed record UpdateStatusDatesRequest(
    bool? BookingStatus, DateTime? PlannedCollection, bool? CollectionStatus, DateTime? ActualCollection,
    bool? PlannedDeliverySet, DateTime? PlannedDelivery, bool? DeliveryStatus, DateTime? ActualDelivery);

public sealed record UpdateForwarderRequestForShipment(long? ForwarderId);

/// <summary>One shipment search result row, outbound-only for this slice — see ShipmentHelper.SearchAsync's own doc comment for why the inbound leg (log.PurchaseOrderShipment) is deferred.</summary>
public sealed record ShipmentSearchRow(
    string Key, string Direction, long ShipmentId, string RefDisplay, string? Customer, string? ForwarderName, string? IncoTerms,
    DateTime? PlannedCollection, DateTime? ActualCollection, DateTime? PlannedDelivery, DateTime? ActualDelivery,
    string? TrackingNumber, bool? BookingStatus, bool? CollectionStatus, bool? DeliveryStatus, bool? ShipmentCancelled, DateTime? SortDate);

public sealed record ShipmentSearchQuery(
    string? ShipmentRef, string? DeliveryNumber, string? Forwarder, string? Customer, string? Tracking,
    string? DateField, DateTime? DateFrom, DateTime? DateTo);
