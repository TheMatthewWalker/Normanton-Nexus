using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Warehouse;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Pallet line-item CRUD — port of routes/palletpackages.js, matching
/// Node's own `api/palletpackages` mount. No permission gate on any
/// action, same reasoning as PalletMainController.
/// </summary>
[Route("api/palletpackages")]
public sealed class PalletPackagesController(INexusOperationsDb nexusOperationsDb, ISapServerClient sapServerClient) : NexusControllerBase
{
    [HttpGet("pallet/{palletId:int}")]
    public async Task<IActionResult> GetByPallet(int palletId, CancellationToken ct)
    {
        var rows = await PalletPackagesHelper.GetByPalletAsync(nexusOperationsDb, palletId, ct);
        return Ok(ApiResponse<IReadOnlyList<PalletPackageRow>>.Ok(rows));
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreatePalletPackageRequest body, CancellationToken ct)
    {
        var result = await PalletPackagesHelper.CreateAsync(nexusOperationsDb, body, ct);
        return StatusCode(201, ApiResponse<CreatePalletPackageResult>.Ok(result));
    }

    [HttpPatch("{palletItemId:int}")]
    public async Task<IActionResult> Update(int palletItemId, [FromBody] UpdatePalletPackageRequest body, CancellationToken ct)
    {
        await PalletPackagesHelper.UpdateAsync(nexusOperationsDb, palletItemId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("{palletItemId:int}")]
    public async Task<IActionResult> Delete(int palletItemId, CancellationToken ct)
    {
        await PalletPackagesHelper.DeleteAsync(nexusOperationsDb, sapServerClient, palletItemId, GetUserId(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }
}
