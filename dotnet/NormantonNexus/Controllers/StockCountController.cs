using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.StockCount;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Stock Count — shared between Finance (approve/reject + Gains/Losses
/// reporting) and Warehouse (everything else — see StockCountModels.cs's
/// scope note; Phase 7 extends this controller/helper rather than
/// duplicating them). View access is department-gated "finance OR
/// warehouse" (tighter than Node, which has no department gate on this
/// router at all); the approve/reject/finance-report actions additionally
/// require Perm:FIN_STOCK_APPROVE, matching Node's requirePermission
/// exactly (already tile-scoped, no legacy-code split needed).
/// </summary>
[Route("api/stockcount")]
[Authorize(Policy = "Dept:" + NexusDepartments.Finance + "," + NexusDepartments.Warehouse)]
public sealed class StockCountController(INexusOperationsDb nexusOperationsDb, ISapServerClient sapServerClient) : NexusControllerBase
{
    [HttpGet("counts")]
    public async Task<IActionResult> ListCounts([FromQuery] string? status, CancellationToken ct)
    {
        var rows = await StockCountHelper.ListCountsAsync(nexusOperationsDb, status, ct);
        return Ok(ApiResponse<IReadOnlyList<StockCountDocumentRow>>.Ok(rows));
    }

    /// <summary>
    /// Lazily creates this week's PTFE Cycle Count if the Monday-morning
    /// Quartz job hasn't fired yet (or was missed), then returns it with
    /// its lines — the actual source of truth per Node's own comment, the
    /// cron is only a pre-warm. No extra permission gate beyond the class-
    /// level department check, matching Node's ungated route exactly.
    /// Registered ahead of any future GET /counts/{id} route so "current-
    /// ptfe" is never captured as an :id segment.
    /// </summary>
    [HttpGet("counts/current-ptfe")]
    public async Task<IActionResult> GetCurrentPtfeCount(CancellationToken ct)
    {
        var result = await StockCountHelper.GetCurrentPtfeCountAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<CurrentPtfeCountResult>.Ok(result));
    }

    [HttpGet("counts/{id:int}/report")]
    public async Task<IActionResult> GetCountReport(int id, [FromQuery] string groupBy = "material", CancellationToken ct = default)
    {
        var rows = await StockCountHelper.GetCountReportAsync(nexusOperationsDb, id, groupBy, ct);
        return Ok(ApiResponse<IReadOnlyList<CountReportRow>>.Ok(rows));
    }

    [HttpPost("counts/{id:int}/approve")]
    [Authorize(Policy = "Perm:" + StockCountHelper.FnStockApprove)]
    public async Task<IActionResult> Approve(int id, CancellationToken ct)
    {
        var result = await StockCountHelper.ApproveAsync(nexusOperationsDb, sapServerClient, id, GetUsername(), GetUserId(), ct);
        return Ok(ApiResponse<ApproveCountResult>.Ok(result));
    }

    [HttpPost("counts/{id:int}/reject")]
    [Authorize(Policy = "Perm:" + StockCountHelper.FnStockApprove)]
    public async Task<IActionResult> Reject(int id, [FromBody] RejectCountRequest body, CancellationToken ct)
    {
        await StockCountHelper.RejectAsync(nexusOperationsDb, id, body, GetUsername(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpGet("reports/finance")]
    [Authorize(Policy = "Perm:" + StockCountHelper.FnStockApprove)]
    public async Task<IActionResult> GetFinanceReport([FromQuery] DateTime? from, [FromQuery] DateTime? to, CancellationToken ct)
    {
        var result = await StockCountHelper.GetFinanceReportAsync(nexusOperationsDb, from, to, ct);
        return Ok(ApiResponse<FinanceReportResult>.Ok(result));
    }
}
