namespace NormantonNexus.Models.Dto;

// Drumming's entry flow (Sub-phase 6c, third slice) — port of
// routes/productionnexus.js's submitDrumming (backing POST /drumming/stock
// and /drumming/customer). Unlike the CO/BR/CL/TW/EX draft->complete
// wizard, Drumming has no separate draft step — the record is created
// already-complete (Status=4, CompletedAt=GETDATE() immediately) in one
// request, same as the direct-entry metre processes (MetreProcessEntryRequest),
// just with the BOM-validated hard block, concession-covered goods-movement
// posting, and braid-consumption auto-backflush layered on top.

/// <summary>
/// entryType ("stock" vs "customer") is NOT a body field — it comes from
/// which of the two literal routes was called, matching Node's own
/// router.post('/drumming/stock', ...)/router.post('/drumming/customer', ...)
/// pair sharing one submitDrumming(req, res, entryType) function.
/// </summary>
public sealed record DrummingSubmitRequest(
    string? Material, int? ShiftId,
    string? CustomerNumber, string? OrderNumber, string? OrderItem,
    string? PackagingId, decimal? WeightKg,
    List<ParentBatchRef>? ParentBatches,
    List<RawMaterialBatchInput>? RawMaterialBatches,
    List<decimal>? CoilLengths,
    bool HasScrap, decimal? ScrapTotalKg, List<ScrapReasonInput>? ScrapReasons,
    string? Comments);

/// <summary>
/// Status is one of "COMPLETE" (posted, possibly with a Warning),
/// "SAP_FAILED" (record saved, HTTP 201, backflush itself failed —
/// same always-201-not-an-error convention every other Production write
/// action uses), or "BLOCKED" (HTTP 409, hard-blocked before any SAP call
/// was even attempted — a genuine error response, unlike every other
/// process's SAP_FAILED convention; mirrors Node's own real behavioral
/// difference here exactly, not normalized away).
/// </summary>
public sealed record DrummingSubmitResult(
    int DrummingId, string BatchRef, string? MaterialDocument, string? Batch,
    bool BomMismatch, string Status, bool ConcessionApplied, string? Warning, string? Error);

/// <summary>One braided (BR) traceability parent's on-demand consumption backflush — see DrummingHelper.BackflushBraidedComponentsAsync.</summary>
internal sealed record BraidConsumptionResult(int BraidingId, string BraidRef, string Material, decimal Quantity, string DocumentNumber);
