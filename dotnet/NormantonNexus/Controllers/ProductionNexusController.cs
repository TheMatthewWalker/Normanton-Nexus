using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Production department, Sub-phase 6a — the 7 supervisor reports, Batch
/// History, and Traceability. Port of the corresponding slice of
/// routes/productionnexus.js (mounted at /api/productionnexus in Node —
/// same URL prefix kept here, distinct from routes/production.js's
/// /api/production legacy-archive reads, not yet ported — see
/// dotnet/CLAUDE.md's Phase 6 notes).
///
/// Class-level Dept:production tightens Node's complete absence of a
/// department gate on this router (requireLogin only) — same precedent
/// every earlier phase set. GetHistory/GetTraceChain additionally require
/// Perm:PROD_SUPERVISOR — Node's own HTML places both the Traceability and
/// Batch History tiles inside its PROD_SUPERVISOR-gated Supervisor section,
/// but neither route actually checks it server-side (a real gap research
/// found); closing it matches the UI's own evident intent and the "API's
/// 403 is the real gate either way" principle already established.
/// </summary>
[Route("api/productionnexus")]
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
public sealed class ProductionNexusController(INexusOperationsDb nexusOperationsDb) : NexusControllerBase
{
    [HttpGet("reports/output")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ReportOutput([FromQuery] ReportFilterQuery query, CancellationToken ct)
    {
        var result = await ProductionReportsHelper.GetOutputAsync(nexusOperationsDb, query, ct);
        return Ok(ApiResponse<ReportOutputResult>.Ok(result));
    }

    [HttpGet("reports/scrap")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ReportScrap([FromQuery] ReportFilterQuery query, CancellationToken ct)
    {
        var result = await ProductionReportsHelper.GetScrapAsync(nexusOperationsDb, query, ct);
        return Ok(ApiResponse<ReportScrapResult>.Ok(result));
    }

    [HttpGet("reports/sap-performance")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ReportSapPerformance([FromQuery] ReportFilterQuery query, CancellationToken ct)
    {
        var result = await ProductionReportsHelper.GetSapPerformanceAsync(nexusOperationsDb, query, ct);
        return Ok(ApiResponse<ReportSapPerfResult>.Ok(result));
    }

    [HttpGet("reports/batches")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ReportBatches([FromQuery] ReportFilterQuery query, CancellationToken ct)
    {
        var rows = await ProductionReportsHelper.GetBatchesAsync(nexusOperationsDb, query, ct);
        return Ok(ApiResponse<IReadOnlyList<ReportBatchStatusRow>>.Ok(rows));
    }

    [HttpGet("reports/shift-comparison")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ReportShiftComparison([FromQuery] ReportFilterQuery query, CancellationToken ct)
    {
        var result = await ProductionReportsHelper.GetShiftComparisonAsync(nexusOperationsDb, query, ct);
        return Ok(ApiResponse<ReportShiftResult>.Ok(result));
    }

    [HttpGet("reports/operator-output")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ReportOperatorOutput([FromQuery] ReportFilterQuery query, CancellationToken ct)
    {
        var rows = await ProductionReportsHelper.GetOperatorOutputAsync(nexusOperationsDb, query, ct);
        return Ok(ApiResponse<IReadOnlyList<ReportOperatorOutputRow>>.Ok(rows));
    }

    [HttpGet("reports/material-output")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> ReportMaterialOutput([FromQuery] ReportFilterQuery query, CancellationToken ct)
    {
        var rows = await ProductionReportsHelper.GetMaterialOutputAsync(nexusOperationsDb, query, ct);
        return Ok(ApiResponse<IReadOnlyList<ReportMaterialOutputRow>>.Ok(rows));
    }

    [HttpGet("history")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> GetHistory([FromQuery] BatchHistoryQuery query, CancellationToken ct)
    {
        var rows = await ProductionHelper.GetHistoryAsync(nexusOperationsDb, query, ct);
        return Ok(ApiResponse<IReadOnlyList<BatchHistoryRow>>.Ok(rows));
    }

    [HttpPost("trace")]
    public async Task<IActionResult> AddTraceLink([FromBody] TraceLinkCreateRequest body, CancellationToken ct)
    {
        await ProductionHelper.AddTraceLinkAsync(nexusOperationsDb, body, GetUsername(), GetUserId(), ct);
        return StatusCode(201, ApiResponse<object?>.Ok(null));
    }

    [HttpGet("trace/{processCode}/{recordId:int}")]
    [Authorize(Policy = "Perm:" + ProductionReportsHelper.FnSupervisor)]
    public async Task<IActionResult> GetTraceChain(string processCode, int recordId, CancellationToken ct)
    {
        var result = await ProductionHelper.GetTraceChainAsync(nexusOperationsDb, processCode, recordId, ct);
        return Ok(ApiResponse<TraceChainResult>.Ok(result));
    }
}
