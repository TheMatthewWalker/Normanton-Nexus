namespace NormantonNexus.Models.Dto;

// Logistics Sub-phase 8d — reference data. ~12 small, uniform CRUD tiles
// (routes/costtypes.js, costelements.js, costcenters.js, forwarders.js,
// forwarderapproval.js, forwardermodemapping.js, materialRequestUnits.js,
// incoterms.js, rateskn.js, ratestpn.js, assignmenttpn.js,
// deliveryroutes.js) — every response is standardized on this app's own
// {success,data,error} ApiResponse<T> envelope rather than Node's own
// inconsistent per-file raw-array/plain-message shapes (some files return
// `res.json(result.recordset)` directly, others `{success,data}` — this
// port always uses the latter, matching every other department).

// ── Cost Types (log.CostTypes) ──────────────────────────────────────────

public sealed record CostTypeRow(long? TypeId, string? TypeDescription);

public sealed record CreateCostTypeRequest(long TypeId, string? TypeDescription);

// ── Cost Elements (log.CostElements) ────────────────────────────────────

public sealed record CostElementRow(long? ElementId, string? ElementDescription, string? ElementCode, string? Direction, string? Tier);

public sealed record CreateCostElementRequest(string ElementCode, string ElementDescription, string? Direction, string? Tier);

// ── Cost Centers (log.CostCenters) ──────────────────────────────────────

public sealed record CostCenterRow(long? CenterId, string? CenterDescription, string? CenterCode);

public sealed record CreateCostCenterRequest(string CenterCode, string CenterDescription);

// ── Forwarders (log.Forwarders) ─────────────────────────────────────────

public sealed record ForwarderRow(long? ForwarderId, string? ForwarderName, bool? ForwarderApproval, string? ForwarderMode);

public sealed record ApprovedForwarderRow(long ForwarderId, string ForwarderName, string? ForwarderMode);

public sealed record CreateForwarderRequest(long ForwarderId, string ForwarderName, bool ForwarderApproval, string? ForwarderMode);

/// <summary>forwarderID is NOT unique on its own — a vendor with several shipping modes gets one row PER MODE, all sharing the same forwarderID/forwarderName — so an update must also pass the row's CURRENT ForwarderMode (OriginalMode) to pin down exactly one row rather than silently overwriting every sibling mode-row.</summary>
public sealed record UpdateForwarderRequest(string ForwarderName, bool ForwarderApproval, string? ForwarderMode, string? OriginalMode);

// ── Forwarder Approval (log.ForwarderApproval) ──────────────────────────

public sealed record ForwarderApprovalRow(long? ForwarderId, bool? RatesAgreed, bool? UsageAgreed);

public sealed record CreateForwarderApprovalRequest(long ForwarderId, bool RatesAgreed, bool UsageAgreed);

// ── Forwarder Mode Mapping (log.ForwarderModeMapping) ───────────────────

public sealed record ForwarderModeMappingRow(int MappingId, string ForwarderMode, string ModeOfTransport, string? Description, DateTime CreatedAtUtc, DateTime UpdatedAtUtc);

public sealed record CreateForwarderModeMappingRequest(string ForwarderMode, string ModeOfTransport, string? Description);

// ── Incoterms (log.Incoterms) ───────────────────────────────────────────

public sealed record IncotermsRow(string? IncotermsId, string? IncotermsDescription);

public sealed record CreateIncotermsRequest(string IncotermsId, string? IncotermsDescription);

// ── Rates KN (log.RatesKN — Kuehne+Nagel freight rates) ─────────────────

public sealed record RatesKnRow(string? CountryCode, string? PostalCode, int? MinWeight, int? MaxWeight, decimal? AgreedRate, int? TransitTime, decimal? MinimumCharge);

public sealed record CreateRatesKnRequest(string CountryCode, string PostalCode, int MinWeight, int MaxWeight, decimal AgreedRate, int TransitTime);

public sealed record RatesKnLookupResult(decimal AgreedRate, decimal? MinimumCharge, int? TransitTime, decimal ChargeableWeight, decimal ExpectedCost);

// ── Rates TPN (log.RatesTPN — pallet-network freight rates) ─────────────

public sealed record RatesTpnRow(string? PostalZone, string? PalletCategory, string? ServiceLevel, decimal? AgreedRate);

public sealed record CreateRatesTpnRequest(string PostalZone, string PalletCategory, string ServiceLevel, decimal AgreedRate);

// ── Assignment TPN (log.AssignmentTPN — postcode -> zone mapping) ───────

public sealed record AssignmentTpnRow(string? PostalZone, string? PostalCode);

public sealed record CreateAssignmentTpnRequest(string PostalZone, string PostalCode);

// ── Delivery Routes (log.DeliveryRoutes — transit-day estimates) ────────

public sealed record DeliveryRouteRow(int RouteId, string CountryCode, string? PostcodePrefix, int TransitDays);

public sealed record CreateDeliveryRouteRequest(string CountryCode, string? PostcodePrefix, int TransitDays);

// ── Material Request Units (log.MaterialRequestUnits) ───────────────────
// MaterialRequestUnitRow itself already lives in StagingModels.cs (built
// first, for Staging Post's own read-only dependency on this table) —
// reused here as-is rather than redeclared.

public sealed record CreateMaterialRequestUnitRequest(string Material, string Unit, decimal ConversionQty);

public sealed record MaterialRequestUnitImportRow(string Material, string Unit, decimal ConversionQty);

public sealed record BulkImportMaterialRequestUnitsRequest(List<MaterialRequestUnitImportRow> Records);

public sealed record MaterialRequestUnitImportError(string? Material, string? Unit, string Error);

public sealed record BulkImportMaterialRequestUnitsResult(int Inserted, int Updated, List<MaterialRequestUnitImportError> Errors);
