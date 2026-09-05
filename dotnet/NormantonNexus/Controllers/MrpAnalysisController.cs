using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// MRP Analysis — Logistics Sub-phase 8b.1 (GET /trends) + 8b.5 (refresh-
/// status, both forecast methods, snapshot history). Port of
/// routes/mrpanalysis.js, mounted at api/mrp-analysis matching Node's own
/// mount. `runMrpHistoryRefresh` (the real SAP-pulling sync job behind
/// POST /refresh) is deferred to 8b.6's refresh-orchestration slice.
/// </summary>
[Route("api/mrp-analysis")]
[Authorize(Policy = "Perm:LOG_MRP")]
public sealed class MrpAnalysisController(INexusDb nexusDb, INexusOperationsDb nexusOperationsDb, IAuditLogger audit, ISapServerClient sapServerClient) : NexusControllerBase
{
    [HttpGet("trends")]
    public async Task<IActionResult> GetTrends([FromQuery] string[]? materials, [FromQuery] long? vendorId, CancellationToken ct) =>
        Ok(ApiResponse<MrpTrendsResult>.Ok(await MrpAnalysisHelper.GetTrendsAsync(nexusOperationsDb, materials, vendorId, ct)));

    [HttpPost("refresh")]
    public async Task<IActionResult> Refresh(CancellationToken ct) =>
        Ok(ApiResponse<RefreshDatasetOutcome>.Ok(await PerformanceSyncHelper.RunMrpHistoryRefreshAsync(nexusDb, nexusOperationsDb, sapServerClient, GetUserId(), ct)));

    [HttpGet("refresh-status")]
    public async Task<IActionResult> GetRefreshStatus(CancellationToken ct) =>
        Ok(ApiResponse<MrpRefreshStatusRow?>.Ok(await MrpAnalysisHelper.GetRefreshStatusAsync(nexusDb, ct)));

    // ── Forecast — Percentage method ─────────────────────────────────────

    [HttpPost("forecast/percentage")]
    public async Task<IActionResult> PreviewPercentageForecast([FromBody] PercentageForecastPreviewRequest body, CancellationToken ct) =>
        Ok(ApiResponse<PercentageForecastPreviewResult>.Ok(await MrpForecastHelper.PreviewPercentageAsync(nexusOperationsDb, body, ct)));

    [HttpPost("forecast/percentage/save")]
    public async Task<IActionResult> SavePercentageForecast([FromBody] PercentageForecastSaveRequest body, CancellationToken ct) =>
        Ok(ApiResponse<CreateMrpForecastRunResult>.Ok(await MrpForecastHelper.SavePercentageAsync(nexusOperationsDb, audit, body, GetUsername(), GetIpAddress(), ct)));

    // ── Forecast — Sales Breakdown method ────────────────────────────────

    [HttpGet("products/export")]
    public async Task<IActionResult> ExportSalesForecastTemplate(CancellationToken ct)
    {
        var rows = await MrpForecastHelper.ListMaterialsForSalesExportAsync(nexusOperationsDb, ct);
        var bytes = MrpForecastHelper.BuildSalesForecastTemplate(rows);
        var fileName = $"mrp-sales-forecast-template_{DateTime.UtcNow:yyyy-MM-dd}.xlsx";
        return File(bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileName);
    }

    [HttpPost("forecast/bom/upload")]
    public async Task<IActionResult> UploadBomForecast([FromQuery] int targetYear, CancellationToken ct)
    {
        using var buffer = new MemoryStream();
        await Request.Body.CopyToAsync(buffer, ct);
        var result = await MrpForecastHelper.UploadBomForecastAsync(sapServerClient, targetYear, buffer.ToArray(), GetUserId(), ct);
        return Ok(ApiResponse<BomUploadResult>.Ok(result));
    }

    [HttpPost("forecast/bom/save")]
    public async Task<IActionResult> SaveBomForecast([FromBody] BomForecastSaveRequest body, CancellationToken ct) =>
        Ok(ApiResponse<CreateMrpForecastRunResult>.Ok(await MrpForecastHelper.SaveBomForecastAsync(nexusOperationsDb, audit, body, GetUsername(), GetIpAddress(), ct)));

    // ── Snapshot history ──────────────────────────────────────────────────

    [HttpGet("forecast/runs")]
    public async Task<IActionResult> ListForecastRuns([FromQuery] int? targetYear, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<MrpForecastRunSummaryRow>>.Ok(await MrpForecastHelper.ListRunsAsync(nexusOperationsDb, targetYear, ct)));

    [HttpGet("forecast/runs/{runId:long}")]
    public async Task<IActionResult> GetForecastRun(long runId, CancellationToken ct)
    {
        var data = await MrpForecastHelper.GetRunDetailAsync(nexusOperationsDb, runId, ct);
        if (data is null) return NotFound(ApiResponse<object?>.Fail("NOT_FOUND", "Forecast run not found."));
        return Ok(ApiResponse<MrpForecastRunDetail>.Ok(data));
    }
}
