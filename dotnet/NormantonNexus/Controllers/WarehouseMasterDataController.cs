using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Warehouse;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Pallet/packaging master data — port of routes/palletdata.js,
/// packagingdata.js, and routes/palletvalidation.js. Each Node file was
/// mounted at its own top-level path with no shared prefix
/// (`/api/palletdata`, `/api/packagingdata`, `/api/palletvalidation`) —
/// kept exactly, via a class-level `api` route plus each action's own full
/// relative path, rather than inventing a `api/warehouse/*` prefix Node
/// never had. Deliberately no Dept:warehouse policy — see
/// WarehouseMasterDataModels.cs's header comment for why (genuinely shared
/// with Logistics, not Warehouse-exclusive).
/// </summary>
[Route("api")]
public sealed class WarehouseMasterDataController(INexusOperationsDb nexusOperationsDb) : NexusControllerBase
{
    [HttpGet("palletdata")]
    public async Task<IActionResult> GetPalletData(CancellationToken ct)
    {
        var rows = await WarehouseMasterDataHelper.GetPalletDataAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<PalletDataRow>>.Ok(rows));
    }

    [HttpPut("palletdata/{palletId}")]
    [Authorize(Policy = "Perm:LOG_ADMIN")] // Logistics-owned legacy code, unchanged from Node — Logistics hasn't been ported yet to split it per-tile.
    public async Task<IActionResult> UpdatePalletData(string palletId, [FromBody] UpdatePalletDataRequest body, CancellationToken ct)
    {
        await WarehouseMasterDataHelper.UpdatePalletDataAsync(nexusOperationsDb, palletId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpGet("packagingdata")]
    public async Task<IActionResult> GetPackagingData(CancellationToken ct)
    {
        var rows = await WarehouseMasterDataHelper.GetPackagingDataAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<PackagingDataRow>>.Ok(rows));
    }

    [HttpPut("packagingdata/{packId}")]
    [Authorize(Policy = "Perm:LOG_ADMIN")]
    public async Task<IActionResult> UpdatePackagingData(string packId, [FromBody] UpdatePackagingDataRequest body, CancellationToken ct)
    {
        await WarehouseMasterDataHelper.UpdatePackagingDataAsync(nexusOperationsDb, packId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpGet("palletvalidation/pallet/{palletId}")]
    public async Task<IActionResult> GetPalletValidation(string palletId, CancellationToken ct)
    {
        var rows = await WarehouseMasterDataHelper.GetValidationForPalletAsync(nexusOperationsDb, palletId, ct);
        return Ok(ApiResponse<IReadOnlyList<PalletValidationRow>>.Ok(rows));
    }
}
