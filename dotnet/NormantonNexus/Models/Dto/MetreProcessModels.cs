namespace NormantonNexus.Models.Dto;

// The shared metre-process (EX/CO/BR/CL/TW) entry engine — port of the
// "Generic entry" AND (as of Sub-phase 6c) "draft/complete" sections of
// routes/productionnexus.js. Direct one-step entry (MetreProcessEntryRequest)
// posts immediately with no BOM validation; the draft->complete two-step
// workflow (MetreDraftRequest/MetreCompleteRequest) downloads/validates a
// BOM snapshot (CO/BR/CL/TW) or an MX-tub-staging-aware check (EX only,
// validateMxTubLinks — EX/MX deliberately kept separate from the BOM-
// snapshot path per Node's own comments) and hard-blocks completion on an
// unresolved traceability mismatch unless an approved concession covers it.

/// <summary>TubId is only meaningful for an MX parent link on a Draft/Complete EX job (validateMxTubLinks) — null for every other process/link, and unused entirely by the direct-entry path (EnterAsync), which predates Draft/Complete and never needed tub-level precision.</summary>
public sealed record ParentBatchRef(string? ProcessCode, int? RecordId, int? TubId = null);

public sealed record ScrapReasonInput(int? ReasonId, decimal? Kg, int? Occurrences);

public sealed record MetreProcessEntryRequest(
    string? Material, decimal? LengthMetres, int? MachineId, int? ShiftId,
    List<ParentBatchRef>? ParentBatches, List<int>? AdditionalOperatorIds,
    bool HasScrap, decimal? ScrapTotalKg, List<ScrapReasonInput>? ScrapReasons, string? Notes);

public sealed record MetreProcessEntryResult(int RecordId, string BatchRef, string? MaterialDocument, string Status, string? Warning, string? Error);

public sealed record OpenEntryRow(int RecordId, string BatchRef, string Material, int? MachineId, string? MachineCode, string? MachineName, string? Notes, DateTime CreatedAt, string? CreatedBy);

public sealed record MetreProcessDataQuery(string? Material, string? DateFrom, string? DateTo);

public sealed record MetreProcessDataRow(
    int RecordId, string BatchRef, int? ShiftId, string? ShiftName, int? MachineId, string? MachineCode, string? MachineName,
    string Material, decimal LengthMetres, int Status, bool IsReversed, string? StatusName,
    DateTime? StartedAt, DateTime? CompletedAt, string? Notes, string? CreatedBy);

public sealed record OpenRunRow(string ProcessCode, int RecordId, string BatchRef, string Material, DateTime CreatedAt, string? CreatedBy);

public sealed record CancelOpenRunRequest(string? Reason);

public sealed record MetreDraftRequest(
    string? Material, int? MachineId, List<ParentBatchRef>? ParentBatches,
    List<RawMaterialBatchInput>? RawMaterialBatches, string? Notes);

public sealed record MetreDraftResult(int RecordId, string BatchRef, IReadOnlyList<string>? Warnings);

public sealed record MetreCompleteRequest(
    decimal? LengthMetres, int? ShiftId, List<int>? AdditionalOperatorIds,
    bool HasScrap, decimal? ScrapTotalKg, List<ScrapReasonInput>? ScrapReasons, string? Notes);

public sealed record MetreCompleteResult(int RecordId, string BatchRef, string? MaterialDocument, string Status, bool ConcessionApplied, string? Warning, string? Error);
