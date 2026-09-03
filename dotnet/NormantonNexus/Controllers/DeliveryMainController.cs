using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Warehouse;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Open Picksheets, Packaging Holding, the picksheet materials/stock
/// panel, linked picksheets, and link-search — the read-only half of
/// routes/deliverymain.js, matching Node's own `api/deliverymain` mount.
/// The write half (link/unlink, stage-batch, comment, cancel-picksheet,
/// completion pipeline) is Sub-phases 7b/7c. No Dept:warehouse policy —
/// Node's own mount is requireLogin-only (server.js); WAREHOUSE_OP gates
/// the specific actions that need it, matching Node's per-route
/// requirePermission calls exactly.
/// </summary>
[Route("api/deliverymain")]
public sealed class DeliveryMainController(INexusOperationsDb nexusOperationsDb, ISapServerClient sapServerClient) : NexusControllerBase
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
}
