namespace NormantonNexus.Models.Dto;

// Logistics Sub-phase 8a.5a — port of routes/shipmentcost.js's non-SAP-calling
// CRUD/read routes (log.ShipmentCost). POST /post-migo, POST /:costId/reverse
// (real SAP purchase-order/goods-receipt creation) and GET /analytics are
// deliberately NOT part of this slice — see ShipmentCostHelper's own header
// comment for why.

/// <summary>Raw `SELECT *`-shaped row — GET /, GET /id/:costId, GET /costtype/:costType.</summary>
public sealed record ShipmentCostRow(
    long CostId, long? ShipmentId, int? PoShipmentId, string? CostType, string? CostElement, string? CostCenter,
    decimal? ExpectedCost, decimal? ActualCost, bool? MigoStatus, string? MaterialDocument, string? ModeOfTransport, string? PurchaseOrder,
    string? ManualReference, long? ManualForwarderId, string? ManualCountry, string? ManualPostcode, string? ManualTrackingNumber, DateTime? ManualIncurredDate);

/// <summary>GET /shipment/:shipmentId — joined with log.CostElements for elementDescription/tier.</summary>
public sealed record ShipmentCostByShipmentRow(
    long CostId, long? ShipmentId, string? CostType, string? CostElement, string? CostCenter,
    decimal? ExpectedCost, decimal? ActualCost, bool? MigoStatus, string? MaterialDocument, string? ModeOfTransport,
    string? ElementDescription, string? Tier);

/// <summary>PATCH /:costId — null means "leave unchanged" (same simplification precedent as UpdatePalletRequest/UpdateManualCargoItemRequest); a non-null blank string is still rejected, matching Node's own `!== undefined` + blank-check behavior.</summary>
public sealed record UpdateShipmentCostRequest(decimal ExpectedCost, string? CostElement, string? CostCenter, string? CostType);

/// <summary>POST / — the outbound "+ Add Cost" flow on the Search Shipment modal.</summary>
public sealed record CreateShipmentCostRequest(
    long? ShipmentId, int? PoShipmentId, string CostType, string CostElement, string CostCenter,
    decimal ExpectedCost, decimal? ActualCost, bool? MigoStatus, string? MaterialDocument, string? ModeOfTransport);

public sealed record CreateShipmentCostResult(long CostId);

/// <summary>POST /manual and PATCH /manual/:costId — same fields for both (create vs. edit-in-place).</summary>
public sealed record ManualShipmentCostRequest(
    string Direction, string Tier, string CostType, string CostCenter, decimal ExpectedCost,
    long ForwarderId, string ModeOfTransport, DateTime IncurredDate, string Reference,
    string Country, string Postcode, string? TrackingNumber, string? CostElement);

public sealed record ManualShipmentCostResult(long CostId, string CostElement);

/// <summary>GET /estimate/:shipmentId — used by the booking modal.</summary>
public sealed record CostEstimateResult(
    bool IsKN, bool IsKennethHowley, string Direction, string Tier, string? ElementCode,
    bool? RateFound, int? ChargeableWeight, decimal? GrossWeight, decimal? VolumetricWeight,
    decimal? AgreedRate, decimal? MinimumCharge, decimal? ExpectedCost, decimal? CustomsCost, string? IncoTerms, string? Message);

/// <summary>GET /unprocessed, GET /processed — the shared cost-list shape (outbound + manual; the inbound leg is deferred to Sub-phase 8b, same as ShipmentHelper.SearchAsync's own inbound leg — see ShipmentCostHelper).</summary>
public sealed record ShipmentCostListRow(
    long CostId, string SourceType, string Direction, long? ShipmentId, string? ShipmentRef, long? ForwarderId,
    DateTime? PlannedCollection, DateTime? ActualCollection, DateTime? DeliveredDate, string? ForwarderName,
    string? CostCenter, string? CostElement, decimal? ExpectedCost, decimal? ActualCost, string? CostType, string? ModeOfTransport,
    string? DestinationCountry, string? DestinationPostCode, string? TrackingNumber, string? MaterialDocument, string? PurchaseOrder);
