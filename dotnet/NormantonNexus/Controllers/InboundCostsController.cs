using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Inbound Log cost tracking ("Associated Costs") — Logistics Sub-phase
/// 8b.4. Port of routes/inboundcosts.js, mounted at api/inboundcosts
/// matching Node's own mount. Every action is gated LOG_MRP, matching
/// Node's uniform `canView = requirePermission('LOG_MRP')`.
/// </summary>
[Route("api/inboundcosts")]
[Authorize(Policy = "Perm:LOG_MRP")]
public sealed class InboundCostsController(INexusOperationsDb nexusOperationsDb) : NexusControllerBase
{
    [HttpGet("shipment/{poShipmentId:long}")]
    public async Task<IActionResult> ListForShipment(long poShipmentId, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<InboundCostLineRow>>.Ok(await InboundCostHelper.ListForShipmentAsync(nexusOperationsDb, poShipmentId, ct)));

    [HttpPost("")]
    public async Task<IActionResult> Add([FromBody] AddInboundCostLineRequest body, CancellationToken ct)
    {
        var result = await InboundCostHelper.AddAsync(nexusOperationsDb, body, ct);
        return StatusCode(201, ApiResponse<AddInboundCostLineResult>.Ok(result));
    }

    [HttpPatch("{costId:long}")]
    public async Task<IActionResult> Update(long costId, [FromBody] UpdateInboundCostLineRequest body, CancellationToken ct) =>
        Ok(ApiResponse<UpdateInboundCostLineResult>.Ok(await InboundCostHelper.UpdateAsync(nexusOperationsDb, costId, body, ct)));

    [HttpDelete("{costId:long}")]
    public async Task<IActionResult> Delete(long costId, CancellationToken ct)
    {
        await InboundCostHelper.DeleteAsync(nexusOperationsDb, costId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }
}
