using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Customs Report reference/fallback data (log.CustomsVatNumberOverrides,
/// log.CustomsHsCodeDescriptions) — Logistics Sub-phase 8c.1, port of
/// routes/customsreportadmin.js. Mounted at api/customs-report-admin,
/// matching Node's own mount path exactly.
///
/// Gated `Perm:LOG_ADMIN` on every action, matching every
/// `requirePermission('LOG_ADMIN')` call in Node — the literal legacy code
/// string, not a new per-tile code, following the same deferred-tile-split
/// precedent every other Logistics sub-phase so far has used (see
/// dotnet/CLAUDE.md's Phase 8 entries) rather than pre-empting Phase 10's
/// cross-cutting Logistics permission-code catch-up on its own.
/// </summary>
[Route("api/customs-report-admin")]
[Authorize(Policy = "Perm:LOG_ADMIN")]
public sealed class CustomsReportAdminController(INexusOperationsDb nexusOperationsDb) : NexusControllerBase
{
    // ── VAT number overrides ─────────────────────────────────────────

    [HttpGet("vat-overrides")]
    public async Task<IActionResult> ListVatOverrides(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<CustomsVatOverrideRow>>.Ok(await CustomsAdminHelper.ListVatOverridesAsync(nexusOperationsDb, ct)));

    [HttpPost("vat-overrides")]
    public async Task<IActionResult> CreateVatOverride([FromBody] CreateCustomsVatOverrideRequest body, CancellationToken ct)
    {
        var overrideId = await CustomsAdminHelper.CreateVatOverrideAsync(nexusOperationsDb, body, GetUsername(), ct);
        return Ok(ApiResponse<object>.Ok(new { overrideId }));
    }

    [HttpPut("vat-overrides/{overrideId:int}")]
    public async Task<IActionResult> UpdateVatOverride(int overrideId, [FromBody] CreateCustomsVatOverrideRequest body, CancellationToken ct)
    {
        await CustomsAdminHelper.UpdateVatOverrideAsync(nexusOperationsDb, overrideId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("vat-overrides/{overrideId:int}")]
    public async Task<IActionResult> DeleteVatOverride(int overrideId, CancellationToken ct)
    {
        await CustomsAdminHelper.DeleteVatOverrideAsync(nexusOperationsDb, overrideId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    // ── HS / commodity code descriptions ─────────────────────────────

    [HttpGet("hs-descriptions")]
    public async Task<IActionResult> ListHsDescriptions(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<CustomsHsDescriptionRow>>.Ok(await CustomsAdminHelper.ListHsDescriptionsAsync(nexusOperationsDb, ct)));

    [HttpPost("hs-descriptions")]
    public async Task<IActionResult> CreateHsDescription([FromBody] CreateCustomsHsDescriptionRequest body, CancellationToken ct)
    {
        var hsCodeId = await CustomsAdminHelper.CreateHsDescriptionAsync(nexusOperationsDb, body, GetUsername(), ct);
        return Ok(ApiResponse<object>.Ok(new { hsCodeId }));
    }

    [HttpPut("hs-descriptions/{hsCodeId:int}")]
    public async Task<IActionResult> UpdateHsDescription(int hsCodeId, [FromBody] CreateCustomsHsDescriptionRequest body, CancellationToken ct)
    {
        await CustomsAdminHelper.UpdateHsDescriptionAsync(nexusOperationsDb, hsCodeId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("hs-descriptions/{hsCodeId:int}")]
    public async Task<IActionResult> DeleteHsDescription(int hsCodeId, CancellationToken ct)
    {
        await CustomsAdminHelper.DeleteHsDescriptionAsync(nexusOperationsDb, hsCodeId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }
}
