using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Warehouse;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Pallet header CRUD — port of routes/palletmain.js, matching Node's own
/// `api/palletmain` mount. No permission gate on any action — Node's file
/// imports no requirePermission calls at all, only `requireLogin` at the
/// server.js mount, kept exactly.
/// </summary>
[Route("api/palletmain")]
public sealed class PalletMainController(INexusOperationsDb nexusOperationsDb, ISapServerClient sapServerClient) : NexusControllerBase
{
    [HttpGet("id/{palletId:int}")]
    public async Task<IActionResult> GetById(int palletId, CancellationToken ct)
    {
        var rows = await PalletMainHelper.GetByIdAsync(nexusOperationsDb, palletId, ct);
        return Ok(ApiResponse<IReadOnlyList<PalletMainRow>>.Ok(rows));
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreatePalletRequest body, CancellationToken ct)
    {
        var result = await PalletMainHelper.CreateAsync(nexusOperationsDb, body, ct);
        return StatusCode(201, ApiResponse<CreatePalletResult>.Ok(result));
    }

    [HttpPatch("{palletId:int}")]
    public async Task<IActionResult> Update(int palletId, [FromBody] UpdatePalletRequest body, CancellationToken ct)
    {
        var result = await PalletMainHelper.UpdateAsync(nexusOperationsDb, sapServerClient, palletId, body, GetUserId(), ct);
        return result.Success
            ? Ok(ApiResponse<PalletUpdateResult>.Ok(result))
            : StatusCode(422, new ApiResponse<PalletUpdateResult>(false, result, new ApiError("UNPROCESSABLE_ENTITY", result.Error ?? "Could not reverse SAP staging.")));
    }
}
