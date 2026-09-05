using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Engineering;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Engineering department — Packaging Data. Thin JSON API layer over
/// EngineeringHelper; all logic lives there. Same route prefix as the Node
/// app's routes/packaging.js (api/packaging) — only the PAGE URLs change in
/// this migration (see Pages/Engineering/*), not the JSON API shape, so
/// nothing else needs to change to keep talking to this.
///
/// Every action requires Dept:engineering (view access, matches
/// routes/packaging.js's canView). Write actions ALSO require their
/// specific per-tile Perm:ENG_* code — a deliberate tightening over Node's
/// literal current behavior, where a write route checks ONLY requirePermission
/// and never additionally checks department membership. See the migration
/// plan's "Authorization model": permission groups are meant to be the
/// tile-access mechanism *within* an already-accessible department, so
/// requiring both here is the intended design, not a compatibility gap.
/// </summary>
[Route("api/packaging")]
[Authorize(Policy = "Dept:" + NexusDepartments.Engineering)]
public sealed class EngineeringController(
    INexusOperationsDb nexusOperationsDb,
    INexusDb nexusDb,
    ISapServerClient sapServerClient,
    ISapCredentialCipher sapCredentialCipher,
    IAuditLogger auditLogger) : NexusControllerBase
{
    [HttpGet("materials")]
    public async Task<IActionResult> SearchMaterials([FromQuery] string? search, CancellationToken ct)
    {
        var materials = await EngineeringHelper.SearchMaterialsAsync(nexusOperationsDb, search, ct);
        return Ok(ApiResponse<IReadOnlyList<MaterialOption>>.Ok(materials));
    }

    [HttpGet("material/{material}/exists")]
    public async Task<IActionResult> MaterialExists(string material, CancellationToken ct)
    {
        var exists = await EngineeringHelper.MaterialExistsAsync(sapServerClient, material, GetUserId(), ct);
        return Ok(ApiResponse<bool>.Ok(exists));
    }

    [HttpGet("material/{material}/description")]
    public async Task<IActionResult> MaterialDescription(string material, CancellationToken ct)
    {
        var description = await EngineeringHelper.GetMaterialDescriptionAsync(sapServerClient, material, GetUserId(), ct);
        return Ok(ApiResponse<string?>.Ok(description));
    }

    [HttpGet("material/{material}/details")]
    public async Task<IActionResult> MaterialDetails(string material, CancellationToken ct)
    {
        var details = await EngineeringHelper.GetMaterialDetailsAsync(sapServerClient, material, GetUserId(), ct);
        return Ok(ApiResponse<PackagingMaraRow?>.Ok(details));
    }

    [HttpGet("material/{material}/bom")]
    public async Task<IActionResult> MaterialBom(string material, CancellationToken ct)
    {
        var bom = await EngineeringHelper.GetMaterialBomAsync(sapServerClient, material, GetUserId(), ct);
        return Ok(ApiResponse<IReadOnlyList<PackagingBomRow>>.Ok(bom));
    }

    [HttpGet("material/{material}/customers")]
    public async Task<IActionResult> MaterialCustomers(string material, CancellationToken ct)
    {
        var customers = await EngineeringHelper.GetMaterialCustomersAsync(sapServerClient, material, GetUserId(), ct);
        return Ok(ApiResponse<IReadOnlyList<PackagingCustomerRow>>.Ok(customers));
    }

    [HttpGet("material/{material}/instruction")]
    public async Task<IActionResult> GetInstruction(string material, [FromQuery] string? customer, CancellationToken ct)
    {
        var instruction = await EngineeringHelper.GetInstructionAsync(sapServerClient, material, customer, GetUserId(), ct);
        return Ok(ApiResponse<PackagingInstrRow?>.Ok(instruction));
    }

    [HttpPut("instruction")]
    [Authorize(Policy = "Perm:" + EngineeringHelper.FnInstructionDetail)]
    public async Task<IActionResult> SaveInstruction([FromBody] PackagingInstrSaveRequest body, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.Material))
        {
            throw new NexusValidationException("material is required.");
        }

        var message = await EngineeringHelper.SaveInstructionAsync(
            sapServerClient, auditLogger, body, GetUserId(), GetUsername(), GetIpAddress(), ct);
        return Ok(ApiResponse<string>.Ok(message));
    }

    [HttpDelete("instruction")]
    [Authorize(Policy = "Perm:" + EngineeringHelper.FnInstructionDetail)]
    public async Task<IActionResult> DeleteInstruction([FromBody] PackagingInstrDeleteRequest body, CancellationToken ct)
    {
        var message = await EngineeringHelper.DeleteInstructionAsync(
            sapServerClient, auditLogger, body, GetUserId(), GetUsername(), GetIpAddress(), ct);
        return Ok(ApiResponse<string>.Ok(message));
    }

    [HttpPost("mass-update")]
    [Authorize(Policy = "Perm:" + EngineeringHelper.FnMassUpdate)]
    public async Task<IActionResult> MassUpdate([FromBody] MassPackagingUpdateRequest body, CancellationToken ct)
    {
        var results = await EngineeringHelper.MassUpdateAsync(
            sapServerClient, auditLogger, body, GetUserId(), GetUsername(), GetIpAddress(), ct);
        return Ok(ApiResponse<IReadOnlyList<MassPackagingUpdateResult>>.Ok(results));
    }

    [HttpPost("create")]
    [Authorize(Policy = "Perm:" + EngineeringHelper.FnNewPackaging)]
    public async Task<IActionResult> CreatePackaging([FromBody] CreatePackagingRequest body, CancellationToken ct)
    {
        var results = await EngineeringHelper.CreatePackagingAsync(
            sapServerClient, sapCredentialCipher, nexusDb, auditLogger, body, GetUserId(), GetUsername(), GetIpAddress(), ct);
        return Ok(ApiResponse<IReadOnlyList<CreatePackagingResult>>.Ok(results));
    }
}
