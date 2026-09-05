using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Warehouse;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Open Picksheets, Packaging Holding, the picksheet materials/stock
/// panel, linked picksheets, link-search, and the delivery completion
/// pipeline — matching Node's own `api/deliverymain` mount. The remaining
/// write half (link/unlink, stage-batch, comment, cancel-picksheet) is a
/// later slice. No Dept:warehouse policy — Node's own mount is
/// requireLogin-only (server.js); WAREHOUSE_OP gates the specific actions
/// that need it, matching Node's per-route requirePermission calls exactly.
/// </summary>
[Route("api/deliverymain")]
public sealed class DeliveryMainController(INexusOperationsDb nexusOperationsDb, ISapServerClient sapServerClient, IAuditLogger auditLogger) : NexusControllerBase
{
    [HttpGet("id/{deliveryId:long}")]
    public async Task<IActionResult> GetById(long deliveryId, CancellationToken ct)
    {
        var row = await WarehousePicksheetHelper.GetByIdAsync(nexusOperationsDb, deliveryId, ct);
        return Ok(ApiResponse<DeliveryMainRow?>.Ok(row));
    }

    [HttpGet("open-picksheets")]
    [Authorize(Policy = "Perm:" + WarehousePicksheetHelper.FnOp)]
    public async Task<IActionResult> GetOpenPicksheets(CancellationToken ct)
    {
        var rows = await WarehousePicksheetHelper.GetOpenPicksheetsAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<OpenPicksheetRow>>.Ok(rows));
    }

    /// <summary>Manual trigger for the same SAP sync server.js's hourly xx:55 cron job runs (Services/BackgroundJobs's WarehouseSapSyncJob) — Phase 10 cross-cutting closeout, discovered missing while wiring Quartz.NET. Always calls SapServer with the shared service token, matching Node's own hardcoded makeSapToken() exactly, regardless of which caller (this button or the cron) triggered it.</summary>
    [HttpPost("sap-sync")]
    [Authorize(Policy = "Perm:LOG_SUPER")]
    public async Task<IActionResult> SapSync(CancellationToken ct)
    {
        var result = await WarehouseSapSyncHelper.RunSapSyncAsync(nexusOperationsDb, sapServerClient, WarehouseSapSyncHelper.ServiceUserId, ct);
        return Ok(ApiResponse<SapSyncResult>.Ok(result));
    }

    [HttpGet("packaging-holding")]
    [Authorize(Policy = "Perm:" + WarehousePicksheetHelper.FnOp)]
    public async Task<IActionResult> GetPackagingHolding(CancellationToken ct)
    {
        var rows = await WarehousePicksheetHelper.GetPackagingHoldingAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<PackagingHoldingRow>>.Ok(rows));
    }

    [HttpGet("{deliveryId:long}/picksheet-materials")]
    [Authorize(Policy = "Perm:" + WarehousePicksheetHelper.FnOp)]
    public async Task<IActionResult> GetPicksheetMaterials(long deliveryId, CancellationToken ct)
    {
        var result = await WarehousePicksheetHelper.GetPicksheetMaterialsAsync(nexusOperationsDb, sapServerClient, deliveryId, GetUserId(), ct);
        return Ok(ApiResponse<PicksheetMaterialsResult>.Ok(result));
    }

    [HttpGet("{deliveryId:long}/linked-picksheets")]
    public async Task<IActionResult> GetLinkedPicksheets(long deliveryId, CancellationToken ct)
    {
        var rows = await WarehousePicksheetHelper.GetLinkedPicksheetsAsync(nexusOperationsDb, deliveryId, ct);
        return Ok(ApiResponse<IReadOnlyList<LinkedPicksheetRow>>.Ok(rows));
    }

    [HttpGet("link-search")]
    [Authorize(Policy = "Perm:" + WarehousePicksheetHelper.FnOp)]
    public async Task<IActionResult> LinkSearch([FromQuery] long? excludeDeliveryId, [FromQuery] string? q, CancellationToken ct)
    {
        var rows = await WarehousePicksheetHelper.LinkSearchAsync(nexusOperationsDb, excludeDeliveryId, q, ct);
        return Ok(ApiResponse<IReadOnlyList<LinkSearchRow>>.Ok(rows));
    }

    [HttpPatch("{deliveryId:long}/complete")]
    [Authorize(Policy = "Perm:" + WarehousePicksheetHelper.FnOp)]
    public async Task<IActionResult> Complete(long deliveryId, CancellationToken ct)
    {
        var result = await DeliveryCompletionHelper.CompleteGroupAsync(nexusOperationsDb, sapServerClient, deliveryId, GetUserId(), ct);
        if (result.Status == "BLOCKED")
        {
            return StatusCode(409, new ApiResponse<CompleteDeliveryGroupResult>(false, result, new ApiError(result.MismatchType ?? "BLOCKED", result.Error ?? "Blocked.")));
        }
        return Ok(ApiResponse<CompleteDeliveryGroupResult>.Ok(result));
    }

    [HttpPost("{deliveryId:long}/sync-delivery-quantities")]
    [Authorize(Policy = "Perm:" + WarehousePicksheetHelper.FnOp)]
    public async Task<IActionResult> SyncDeliveryQuantities(long deliveryId, CancellationToken ct)
    {
        var result = await DeliveryCompletionHelper.SyncDeliveryQuantitiesAsync(nexusOperationsDb, sapServerClient, auditLogger, deliveryId, GetUsername(), GetIpAddress(), GetUserId(), ct);
        return result.Success
            ? Ok(ApiResponse<object?>.Ok(null))
            : StatusCode(result.StatusCode, new ApiResponse<object?>(false, null, new ApiError(result.StatusCode == 422 ? "UNPROCESSABLE_ENTITY" : "CONFLICT", result.Error ?? "Sync failed.")));
    }

    [HttpGet("zdelflag/warnings")]
    [Authorize(Policy = "Perm:" + WarehousePicksheetHelper.FnOp)]
    public async Task<IActionResult> GetZdelflagWarnings(CancellationToken ct)
    {
        var rows = await DeliveryCompletionHelper.GetZdelflagWarningsAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<DeliveryRunWarningRow>>.Ok(rows));
    }

    [HttpGet("{deliveryId:long}/zdelflag/status")]
    [Authorize(Policy = "Perm:" + WarehousePicksheetHelper.FnOp)]
    public async Task<IActionResult> GetZdelflagStatus(long deliveryId, CancellationToken ct)
    {
        var result = await DeliveryCompletionHelper.GetZdelflagStatusAsync(nexusOperationsDb, deliveryId, ct);
        return Ok(ApiResponse<DeliveryRunStatusResult>.Ok(result));
    }

    [HttpPost("{deliveryId:long}/zdelflag/reprocess")]
    [Authorize(Policy = "Perm:" + WarehousePicksheetHelper.FnOp)]
    public async Task<IActionResult> ReprocessZdelflag(long deliveryId, CancellationToken ct)
    {
        var result = await DeliveryCompletionHelper.ReprocessZdelflagAsync(nexusOperationsDb, sapServerClient, deliveryId, ct);
        return Ok(ApiResponse<ZdelflagRunResult>.Ok(result));
    }

    [HttpPost("{deliveryId:long}/zdelflag/resolve")]
    [Authorize(Policy = "Perm:LOG_SUPER")]
    public async Task<IActionResult> ResolveZdelflag(long deliveryId, [FromBody] ResolveRunRequest body, CancellationToken ct)
    {
        await DeliveryCompletionHelper.ResolveZdelflagAsync(nexusOperationsDb, deliveryId, body, GetUsername(), GetUserId(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpGet("goods-issue/warnings")]
    [Authorize(Policy = "Perm:" + WarehousePicksheetHelper.FnOp)]
    public async Task<IActionResult> GetGoodsIssueWarnings(CancellationToken ct)
    {
        var rows = await DeliveryCompletionHelper.GetGoodsIssueWarningsAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<DeliveryRunWarningRow>>.Ok(rows));
    }

    [HttpGet("{deliveryId:long}/goods-issue/status")]
    [Authorize(Policy = "Perm:" + WarehousePicksheetHelper.FnOp)]
    public async Task<IActionResult> GetGoodsIssueStatus(long deliveryId, CancellationToken ct)
    {
        var result = await DeliveryCompletionHelper.GetGoodsIssueStatusAsync(nexusOperationsDb, deliveryId, ct);
        return Ok(ApiResponse<DeliveryRunStatusResult>.Ok(result));
    }

    [HttpPost("{deliveryId:long}/goods-issue/reprocess")]
    [Authorize(Policy = "Perm:" + WarehousePicksheetHelper.FnOp)]
    public async Task<IActionResult> ReprocessGoodsIssue(long deliveryId, CancellationToken ct)
    {
        var result = await DeliveryCompletionHelper.ReprocessGoodsIssueAsync(nexusOperationsDb, sapServerClient, deliveryId, GetUserId(), ct);
        return Ok(ApiResponse<GoodsIssueRunResult>.Ok(result));
    }

    [HttpPost("{deliveryId:long}/goods-issue/resolve")]
    [Authorize(Policy = "Perm:LOG_SUPER")]
    public async Task<IActionResult> ResolveGoodsIssue(long deliveryId, [FromBody] ResolveRunRequest body, CancellationToken ct)
    {
        await DeliveryCompletionHelper.ResolveGoodsIssueAsync(nexusOperationsDb, deliveryId, body, GetUsername(), GetUserId(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }
}
