using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Warehouse;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Notifications;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Staging Post — material requisitions from Production to Stores. Port of
/// routes/staging.js. No Dept:warehouse/Perm:WAREHOUSE_OP gate on the main
/// actions — Node's own mount is requireLogin-only (any logged-in user,
/// including Production floor staff raising a request), matching
/// StagingHelper's own header comment. Only bin-restriction writes are
/// LOG_SUPER-gated, exactly as in Node. GET /kpi/export was deliberately
/// not ported — see StagingHelper's header comment.
/// </summary>
[Route("api/staging")]
public sealed class StagingController(
    INexusOperationsDb nexusOperationsDb, ISapServerClient sapServerClient,
    IAuditLogger auditLogger, INotificationService notificationService) : NexusControllerBase
{
    [HttpGet("materials")]
    public async Task<IActionResult> SearchMaterials([FromQuery] string? search, [FromQuery] string? by, CancellationToken ct)
    {
        var rows = await StagingHelper.SearchMaterialsAsync(nexusOperationsDb, search, by, ct);
        return Ok(ApiResponse<IReadOnlyList<StagingMaterialSearchRow>>.Ok(rows));
    }

    [HttpGet("requests/open")]
    public async Task<IActionResult> GetOpenRequests(CancellationToken ct)
    {
        var rows = await StagingHelper.ListOpenAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<StagingRequestRow>>.Ok(rows));
    }

    [HttpGet("requests/open-summary")]
    public async Task<IActionResult> GetOpenSummary(CancellationToken ct)
    {
        var summary = await StagingHelper.GetOpenSummaryAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<StagingOpenSummary>.Ok(summary));
    }

    [HttpGet("requests")]
    public async Task<IActionResult> GetAllRequests(CancellationToken ct)
    {
        var rows = await StagingHelper.ListAllAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<StagingRequestRow>>.Ok(rows));
    }

    [HttpGet("requests/completed")]
    public async Task<IActionResult> GetCompletedRequests([FromQuery] DateTime? from, [FromQuery] DateTime? to, CancellationToken ct)
    {
        var rows = await StagingHelper.ListCompletedAsync(nexusOperationsDb, from, to, ct);
        return Ok(ApiResponse<IReadOnlyList<StagingRequestRow>>.Ok(rows));
    }

    [HttpGet("requests/{requestId:int}")]
    public async Task<IActionResult> GetRequestById(int requestId, CancellationToken ct)
    {
        var detail = await StagingHelper.GetByIdAsync(nexusOperationsDb, requestId, ct);
        return Ok(ApiResponse<StagingRequestDetail>.Ok(detail));
    }

    [HttpPost("requests")]
    public async Task<IActionResult> CreateRequest([FromBody] CreateStagingRequestRequest body, CancellationToken ct)
    {
        var result = await StagingHelper.CreateAsync(nexusOperationsDb, sapServerClient, auditLogger, notificationService, body, GetUsername(), GetIpAddress(), GetUserId(), ct);
        return Ok(ApiResponse<CreateStagingRequestResult>.Ok(result));
    }

    [HttpPost("requests/{requestId:int}/cancel")]
    public async Task<IActionResult> CancelRequest(int requestId, CancellationToken ct)
    {
        await StagingHelper.CancelAsync(nexusOperationsDb, auditLogger, requestId, GetUsername(), GetIpAddress(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("requests/{requestId:int}/complete")]
    public async Task<IActionResult> CompleteRequest(int requestId, CancellationToken ct)
    {
        await StagingHelper.CompleteAsync(nexusOperationsDb, auditLogger, requestId, GetUsername(), GetIpAddress(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpGet("stock")]
    public async Task<IActionResult> GetStock([FromQuery] string? material, CancellationToken ct)
    {
        var rows = await StagingHelper.GetStockAsync(sapServerClient, GetUserId(), material, ct);
        return Ok(ApiResponse<IReadOnlyList<SapStockRow>>.Ok(rows));
    }

    [HttpGet("requests/{requestId:int}/stock")]
    public async Task<IActionResult> GetRequestStock(int requestId, CancellationToken ct)
    {
        var result = await StagingHelper.GetRequestStockAsync(nexusOperationsDb, sapServerClient, GetUserId(), requestId, ct);
        return Ok(ApiResponse<RequestStockResult>.Ok(result));
    }

    [HttpPost("requests/{requestId:int}/deliver")]
    public async Task<IActionResult> DeliverRequest(int requestId, [FromBody] DeliverStagingRequestRequest body, CancellationToken ct)
    {
        var result = await StagingHelper.DeliverAsync(nexusOperationsDb, sapServerClient, auditLogger, requestId, body, GetUsername(), GetIpAddress(), GetUserId(), ct);
        if (result.Status == "REJECTED")
        {
            return StatusCode(422, new ApiResponse<DeliverStagingRequestResult>(false, result, new ApiError("UNPROCESSABLE_ENTITY", result.Error ?? "SAP rejected the transfer order.")));
        }
        return Ok(ApiResponse<DeliverStagingRequestResult>.Ok(result));
    }

    [HttpGet("kpi")]
    public async Task<IActionResult> GetKpis([FromQuery] DateTime? from, [FromQuery] DateTime? to, CancellationToken ct)
    {
        var result = await StagingHelper.ComputeKpisAsync(nexusOperationsDb, from, to, ct);
        return Ok(ApiResponse<StagingKpiResult>.Ok(result));
    }

    [HttpGet("bin-restrictions")]
    public async Task<IActionResult> GetBinRestrictions(CancellationToken ct)
    {
        var rows = await StagingHelper.ListBinRestrictionsAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<StagingBinRestrictionRow>>.Ok(rows));
    }

    [HttpPost("bin-restrictions")]
    [Authorize(Policy = "Perm:LOG_SUPER")]
    public async Task<IActionResult> CreateBinRestriction([FromBody] CreateBinRestrictionRequest body, CancellationToken ct)
    {
        var restrictionId = await StagingHelper.CreateBinRestrictionAsync(nexusOperationsDb, body, GetUsername(), ct);
        return Ok(ApiResponse<object>.Ok(new { restrictionId }));
    }

    [HttpPut("bin-restrictions/{restrictionId:int}")]
    [Authorize(Policy = "Perm:LOG_SUPER")]
    public async Task<IActionResult> UpdateBinRestriction(int restrictionId, [FromBody] CreateBinRestrictionRequest body, CancellationToken ct)
    {
        await StagingHelper.UpdateBinRestrictionAsync(nexusOperationsDb, restrictionId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("bin-restrictions/{restrictionId:int}")]
    [Authorize(Policy = "Perm:LOG_SUPER")]
    public async Task<IActionResult> DeleteBinRestriction(int restrictionId, CancellationToken ct)
    {
        await StagingHelper.DeleteBinRestrictionAsync(nexusOperationsDb, restrictionId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("bin-restrictions/bulk")]
    [Authorize(Policy = "Perm:LOG_SUPER")]
    public async Task<IActionResult> BulkImportBinRestrictions([FromBody] BulkImportBinRestrictionsRequest body, CancellationToken ct)
    {
        var result = await StagingHelper.BulkImportBinRestrictionsAsync(nexusOperationsDb, body.Records, GetUsername(), ct);
        return Ok(ApiResponse<BulkImportBinRestrictionsResult>.Ok(result));
    }
}
