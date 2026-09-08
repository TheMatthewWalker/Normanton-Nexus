namespace NormantonNexus.Models.Dto;

// ── Logistics Sub-phase 8b.4: Inbound Log cost tracking ("Associated Costs") ──
// Same log.ShipmentCost table the outbound freight-cost flow (ShipmentCostHelper,
// Sub-phase 8a.5a) uses, distinguished by which FK is set (poShipmentID here vs
// shipmentID there) — posting to SAP happens through that same shared flow
// (POST /api/shipmentcost/post-migo), not a separate route here.

/// <summary>PoShipmentId is int, matching log.ShipmentCost.poShipmentID's real column type — CostId stays long (that column is genuinely bigint).</summary>
public sealed record InboundCostLineRow(
    long CostId, int PoShipmentId, string? CostElement, string? CostCenter, string? CostType,
    decimal ExpectedCost, decimal? ActualCost, bool MigoStatus, string? MaterialDocument, string? ModeOfTransport,
    string? ElementDescription, string? Tier);

/// <summary>Body for POST / — costType is required here (the deliberate, full-context "Add Cost" entry point); costCenter is only honored when the target shipment IsManual.</summary>
public sealed record AddInboundCostLineRequest(int? PoShipmentId, string? Tier, decimal? Amount, string? CostType, string? Information, string? ModeOfTransport, string? CostCenter);

public sealed record AddInboundCostLineResult(long CostId, string ElementCode, bool ForwarderSet);

public sealed record UpdateInboundCostLineRequest(string? Tier, decimal? Amount, string? CostType, string? CostCenter);

public sealed record UpdateInboundCostLineResult(long CostId, string ElementCode);
