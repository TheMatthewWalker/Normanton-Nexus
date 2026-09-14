namespace NormantonNexus.Models.Dto;

// Billet Staging — mix tub lifecycle (stage / return / search), port of
// the corresponding section of routes/productionnexus.js. Purely a
// Normanton-Nexus-only concept (mix materials are not batch-managed in
// SAP, so there's no SAP counterpart to keep in sync) — reached in Node
// via the Extrusion entry wizard's parent-picker "chooser," not a
// top-level tile of its own; ported here as a real standalone page (still
// useful on its own before the Extrusion wizard — Sub-phase 6b's next
// slice — exists to link into it).

public sealed record BilletStagingQueueRow(
    int TubId, int MixingId, int TubSeq, string SupplierTubNo, decimal TubWeightKg,
    string Material, string MixCode, string? MixRef, DateTime? CompletedAt, decimal AgeHours, string Bucket);

public sealed record StageTubResult(int TubId, string MixRef, int TubSeq, decimal StagedQuantityKg);

public sealed record StageByRefRequest(string? Ref);

public sealed record ReturnToConditioningRequest(decimal QuantityKg, string? Notes);

public sealed record ReturnToConditioningResult(int TubId, decimal StagedQuantityKg, bool IsStaged);

public sealed record TubSearchRow(
    int TubId, int MixingId, int TubSeq, string SupplierTubNo, decimal TubWeightKg,
    bool IsStaged, decimal? StagedQuantityKg, decimal? ConditioningTimeHours, bool IsScrapped,
    string Material, string MixCode, string? MixRef, DateTime? CompletedAt, decimal AgeHours, string Bucket);

// Expired Mix Batches — GET mixing/expired + the two supervisor actions
// (scrap the expired tub for real via SAP, or override the expiry and
// stage it anyway). Genuinely missing from every prior slice of this
// migration — found by a later gap audit against the Node tile inventory,
// not a deliberate deferral. Reuses GetQueueAsync's AgeHoursSql fragment
// but with the opposite >96h filter, matching Node's own GET
// /mixing/expired query exactly.

public sealed record ExpiredMixTubRow(
    int TubId, int MixingId, int TubSeq, string SupplierTubNo, decimal TubWeightKg,
    string Material, string MixCode, string? MixRef, DateTime? CompletedAt, decimal AgeHours);

/// <summary>ReasonId defaults to 241 ("Out of date polymer mix", AppliesTo='MX') when omitted, matching Node's `Number(req.body?.reasonID) || 241`.</summary>
public sealed record ScrapExpiredTubRequest(int? ReasonId);

public sealed record ScrapExpiredTubResult(int TubId, int ScrapId, string? MaterialDocument);

public sealed record OverrideExpiryRequest(string? Reason);

public sealed record OverrideExpiryResult(int TubId, decimal StagedQuantityKg);
