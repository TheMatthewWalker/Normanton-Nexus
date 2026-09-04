using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// MRP Analysis — Logistics Sub-phase 8b.1 (GET /trends only; refresh/
/// forecast/BOM-explosion routes deferred to 8b.5 — see dotnet/CLAUDE.md).
/// Port of routes/mrpanalysis.js, mounted at api/mrp-analysis matching
/// Node's own mount.
/// </summary>
[Route("api/mrp-analysis")]
public sealed class MrpAnalysisController(INexusOperationsDb nexusOperationsDb) : NexusControllerBase
{
    [HttpGet("trends")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> GetTrends([FromQuery] string[]? materials, [FromQuery] long? vendorId, CancellationToken ct) =>
        Ok(ApiResponse<MrpTrendsResult>.Ok(await MrpAnalysisHelper.GetTrendsAsync(nexusOperationsDb, materials, vendorId, ct)));
}
