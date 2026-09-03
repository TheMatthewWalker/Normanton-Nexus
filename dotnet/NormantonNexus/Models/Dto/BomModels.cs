namespace NormantonNexus.Models.Dto;

// BOM download/persistence/validation + Traceability Concessions (raise
// half — Quality's Phase 3 already built the review half, see
// QualityModels.cs's ConcessionRow/ConcessionReviewRequest) — port of the
// shared infrastructure in routes/productionnexus.js backing the CO/BR/
// CL/TW/DR draft→complete two-step wizard (not yet built) and Drumming's
// entry flow (not yet built). This slice ships the process-generic
// pieces both of those will build on: BOM preview/persist/refresh,
// raw-material batch CRUD, and concession raising.

/// <summary>Enriched BOM row — SapServer's raw BomRow plus the profit-centre classification (bulk-looked-up, one round trip) that tells a raw material (bought in, no portal record) apart from a portal-tracked semi-finished component.</summary>
public sealed record BomRow(string Component, decimal ComponentQty, string ComponentUnit, string? Item, string? StorageLocation, string? ProfitCentre, bool IsRawMaterial);

public sealed record TraceabilityProblem(string? ProcessCode, int? RecordId, string? Material, string Reason);

public sealed record ParentBatchLink(string ProcessCode, int RecordId);

public sealed record RawMaterialBatchInput(string? Material, string? BatchNumber);

public sealed record RawMaterialBatchRow(int BatchId, string Material, string BatchNumber);

public sealed record AddRawMaterialBatchRequest(string Material, string BatchNumber);

public sealed record BomRefreshResult(IReadOnlyList<BomRow> BomRows, IReadOnlyList<TraceabilityProblem> Problems);

public sealed record ApprovedConcessionRow(int ConcessionId, string Component, string ActualMaterial, decimal? Quantity);

/// <summary>The explicit per-component posting list SapServer's goods-movement-backflush endpoint needs when a job posts under one or more approved concessions — every component is posted explicitly (correct ones included), not just the mismatched one.</summary>
public sealed record ActualComponent(string Material, decimal Quantity, string Unit, string? StorageLocation);

public sealed record RaiseConcessionRequest(string ParentProcessCode, int ParentRecordId, string Component, string ActualMaterial, decimal? Quantity, string Reason);

public sealed record RaiseConcessionResult(int ConcessionId);
