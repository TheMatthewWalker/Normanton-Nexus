namespace NormantonNexus.Models.Dto;

// The shared metre-process (EX/CO/BR/CL/TW) entry engine — port of the
// "Generic entry" section of routes/productionnexus.js. SCOPE NOTE: this
// covers only the direct one-step entry (immediate backflush, no BOM
// download/validation) plus open-entries listing, historical data, and
// the cross-process Open Runs supervisor view. The draft->complete
// two-step workflow (POST /process/:pc/draft, POST /process/:pc/complete)
// needs BOM download/validation and the hard-block-vs-concession branch —
// real, researched, unbuilt scope deferred to Sub-phase 6c alongside
// Drumming and Traceability Concessions, which share the same BOM helper
// block. See dotnet/CLAUDE.md's Phase 6 notes.

public sealed record ParentBatchRef(string? ProcessCode, int? RecordId);

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
