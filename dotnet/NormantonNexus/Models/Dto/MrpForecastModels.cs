namespace NormantonNexus.Models.Dto;

// ── Logistics Sub-phase 8b.5: MRP Analysis forecasting ─────────────────────
// Two ways to turn a sales outlook into a raw-material purchasing number for
// next year: a %-increase extrapolation against past consumption
// (Percentage method), or a full sales-unit breakdown exploded down through
// SAP's multi-level BOM to raw materials (Sales Breakdown method, via
// SapServer's already-existing MrpAnalysisController.ExplodeBom). Every
// forecast calculation is saved as an immutable, dated snapshot in
// log.MrpForecastRun — a preview endpoint computes/returns the result
// without writing anything, a separate save endpoint (fed the previewed
// data back) is what actually creates the snapshot.

public sealed record MrpRefreshStatusRow(string? Status, DateTime? CompletedAtUtc, string? ErrorMessage, long RunId);

public sealed record MrpForecastRunSummaryRow(long RunId, int TargetYear, string Method, int? BaselineYear, decimal? PercentageChange, string? CreatedBy, DateTime CreatedAtUtc);

public sealed record MrpForecastRunMaterialRow(string Material, string? MaterialText, decimal PredictedQty, string? Uom);

public sealed record MrpForecastRunProductRow(string Material, string? MaterialText, decimal ExpectedSalesUnits);

public sealed record MrpForecastRunDetail(
    long RunId, int TargetYear, string Method, int? BaselineYear, decimal? PercentageChange, string? CreatedBy, DateTime CreatedAtUtc,
    IReadOnlyList<MrpForecastRunMaterialRow> Materials, IReadOnlyList<MrpForecastRunProductRow> Products);

// ── Percentage method ───────────────────────────────────────────────────

public sealed record PercentageForecastPreviewRequest(int? BaselineYear, decimal? PercentageChange, List<string>? Materials);

/// <summary>Uom is always null here — Node's own applyPercentage never actually populates it (a kept-as-is dead field in the response shape, not a gap in this port).</summary>
public sealed record PercentageForecastMaterialResult(string Material, string? MaterialText, decimal ActualQty, decimal? AnnualisedQty, decimal PredictedQty, string? Uom);

public sealed record PercentageForecastPreviewResult(int BaselineYear, decimal PercentageChange, bool IsPartialYearBaseline, IReadOnlyList<PercentageForecastMaterialResult> Materials);

public sealed record PercentageForecastSaveRequest(int? TargetYear, int? BaselineYear, decimal? PercentageChange, List<PercentageForecastMaterialResult>? Materials);

public sealed record CreateMrpForecastRunResult(long RunId);

/// <summary>Shared shape for the log.MrpForecastRunMaterial child-row insert — both forecast methods' save routes funnel their own material list into this before calling MrpForecastHelper.CreateRunAsync.</summary>
public sealed record MrpForecastRunMaterialInput(string Material, decimal PredictedQty, string? Uom);

// ── Sales Breakdown method ──────────────────────────────────────────────

public sealed record MaterialForSalesExportRow(string Material, string? MaterialText, string? MaterialType, string? ProfitCentre, string? Uom);

public sealed record BomUploadRowResult(int Row, bool Success, string? Error);

public sealed record BomUploadProduct(string Material, decimal ExpectedSalesUnits);

public sealed record BomUploadRawMaterial(string Material, decimal Quantity, string? Uom);

public sealed record BomUploadResult(
    int TargetYear, int Total, int Succeeded, int Failed, IReadOnlyList<BomUploadRowResult> Results,
    IReadOnlyList<BomUploadProduct> Products, IReadOnlyList<BomUploadRawMaterial> RawMaterials, IReadOnlyList<string> Unresolved);

public sealed record BomForecastSaveRequest(int? TargetYear, List<BomUploadProduct>? Products, List<BomUploadRawMaterial>? RawMaterials);

// ── SapServer's MrpAnalysisController.ExplodeBom contract (see SapServer/Models/Bapi/MrpAnalysisModels.cs) ──

public sealed record BomExplosionRequestItem(string Material, decimal Quantity);

public sealed record BomExplosionSapRequest(List<BomExplosionRequestItem> Items);

public sealed record RawMaterialRequirementSapRow(string Material, decimal Quantity, string? Uom);

public sealed record BomExplosionSapResponse(List<RawMaterialRequirementSapRow> RawMaterials, List<string> Unresolved);
