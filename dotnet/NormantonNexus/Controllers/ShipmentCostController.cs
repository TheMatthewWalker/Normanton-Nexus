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
/// Freight cost lines — Logistics Sub-phase 8a.5a (CRUD/read) + 8a.5b (real
/// SAP PO/goods-receipt posting and reversal). Port of routes/
/// shipmentcost.js — see ShipmentCostHelper's and
/// ShipmentCostSapPostingHelper's own header comments for what's still
/// deliberately excluded (GET /analytics — needs the same not-yet-ported
/// inbound leg as the rest of this controller). Mounted at api/shipmentcost,
/// matching Node's own separate router mount exactly (not api/shipmentmain).
/// </summary>
[Route("api/shipmentcost")]
public sealed class ShipmentCostController(
    INexusOperationsDb nexusOperationsDb, INexusDb nexusDb, ISapServerClient sapServerClient, ISapCredentialCipher sapCredentialCipher) : NexusControllerBase
{
    [HttpGet("")]
    public async Task<IActionResult> GetAll(CancellationToken ct)
    {
        var rows = await ShipmentCostHelper.GetAllAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<ShipmentCostRow>>.Ok(rows));
    }

    [HttpGet("id/{costId:long}")]
    public async Task<IActionResult> GetById(long costId, CancellationToken ct)
    {
        var rows = await ShipmentCostHelper.GetByIdAsync(nexusOperationsDb, costId, ct);
        return Ok(ApiResponse<IReadOnlyList<ShipmentCostRow>>.Ok(rows));
    }

    [HttpPatch("{costId:long}")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> Update(long costId, [FromBody] UpdateShipmentCostRequest body, CancellationToken ct)
    {
        await ShipmentCostHelper.UpdateAsync(nexusOperationsDb, costId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("{costId:long}")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> Delete(long costId, CancellationToken ct)
    {
        await ShipmentCostHelper.DeleteAsync(nexusOperationsDb, costId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpGet("shipment/{shipmentId:long}")]
    public async Task<IActionResult> GetByShipment(long shipmentId, CancellationToken ct)
    {
        var rows = await ShipmentCostHelper.GetByShipmentAsync(nexusOperationsDb, shipmentId, ct);
        return Ok(ApiResponse<IReadOnlyList<ShipmentCostByShipmentRow>>.Ok(rows));
    }

    [HttpGet("costtype/{costType}")]
    public async Task<IActionResult> GetByCostType(string costType, CancellationToken ct)
    {
        var rows = await ShipmentCostHelper.GetByCostTypeAsync(nexusOperationsDb, costType, ct);
        return Ok(ApiResponse<IReadOnlyList<ShipmentCostRow>>.Ok(rows));
    }

    [HttpPost("")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> Create([FromBody] CreateShipmentCostRequest body, CancellationToken ct)
    {
        var result = await ShipmentCostHelper.CreateAsync(nexusOperationsDb, body, ct);
        return StatusCode(201, ApiResponse<CreateShipmentCostResult>.Ok(result));
    }

    [HttpPost("manual")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> CreateManual([FromBody] ManualShipmentCostRequest body, CancellationToken ct)
    {
        var result = await ShipmentCostHelper.CreateManualAsync(nexusOperationsDb, body, ct);
        return StatusCode(201, ApiResponse<ManualShipmentCostResult>.Ok(result));
    }

    [HttpPatch("manual/{costId:long}")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> UpdateManual(long costId, [FromBody] ManualShipmentCostRequest body, CancellationToken ct)
    {
        var result = await ShipmentCostHelper.UpdateManualAsync(nexusOperationsDb, costId, body, ct);
        return Ok(ApiResponse<ManualShipmentCostResult>.Ok(result));
    }

    [HttpGet("estimate/{shipmentId:long}")]
    public async Task<IActionResult> GetEstimate(long shipmentId, CancellationToken ct)
    {
        var result = await ShipmentCostHelper.GetEstimateAsync(nexusOperationsDb, shipmentId, ct);
        return Ok(ApiResponse<CostEstimateResult>.Ok(result));
    }

    [HttpGet("unprocessed")]
    public async Task<IActionResult> GetUnprocessed(CancellationToken ct)
    {
        var rows = await ShipmentCostHelper.GetUnprocessedAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<ShipmentCostListRow>>.Ok(rows));
    }

    [HttpGet("processed")]
    public async Task<IActionResult> GetProcessed(CancellationToken ct)
    {
        var rows = await ShipmentCostHelper.GetProcessedAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<ShipmentCostListRow>>.Ok(rows));
    }

    // ── Sub-phase 8a.5b: real SAP PO/goods-receipt posting + reversal ──

    [HttpPost("post-migo")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> PostMigo([FromBody] PostMigoRequest body, CancellationToken ct)
    {
        var result = await ShipmentCostSapPostingHelper.PostMigoAsync(nexusOperationsDb, nexusDb, sapServerClient, sapCredentialCipher, body.CostIds, GetUserId(), ct);
        if (result.Error is not null)
            return StatusCode(400, new ApiResponse<PostMigoResult>(false, result, new ApiError("VALIDATION_ERROR", result.Error)));
        return Ok(ApiResponse<PostMigoResult>.Ok(result));
    }

    [HttpPost("{costId:long}/reverse")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> Reverse(long costId, CancellationToken ct)
    {
        var result = await ShipmentCostSapPostingHelper.ReverseAsync(nexusOperationsDb, sapServerClient, costId, GetUserId(), ct);
        return Ok(ApiResponse<ReverseShipmentCostResult>.Ok(result));
    }
}
