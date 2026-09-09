namespace NormantonNexus.Models.Dto;

// Mixing tile — port of the POST /mixing/entry route in
// routes/productionnexus.js (part of Sub-phase 6b). Every mix's tubs post
// an independent SAP backflush each (not one combined posting) — see
// MixingHelper.EnterAsync's own doc comment.

public sealed record MixingTubInput(decimal WeightKg);

public sealed record MixingEntryRequest(string? MixCode, string? SupplierBatchNo, string? SupplierTubNo, List<MixingTubInput>? Tubs, string? Notes);

public sealed record MixingTubResult(int TubId, int TubSeq, string SupplierTubNo, decimal WeightKg, string? MaterialDocument, string? Error, bool Success);

public sealed record MixingEntryResult(int RecordId, int MixingId, string BatchRef, string Status, decimal TotalWeightKg, List<MixingTubResult> Tubs, string? Warning);
