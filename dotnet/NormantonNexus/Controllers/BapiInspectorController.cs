using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Admin;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Controllers;

/// <summary>
/// BAPI/RFC Structure Inspector — Phase 9, superadmin-only. Port of
/// routes/bapiInspector.js, mounted at api/admin/bapi-inspector per
/// server.js. Gated the same way as DbExplorerController (Role:superadmin,
/// not the api/admin mount's blanket Role:admin) — this reaches arbitrary
/// SAP function metadata, the SAP-side equivalent of dbexplorer's
/// arbitrary SQL schema browsing.
/// </summary>
[Route("api/admin/bapi-inspector")]
[Authorize(Policy = "Role:superadmin")]
public sealed class BapiInspectorController(ISapServerClient sapServerClient, IAuditLogger audit) : NexusControllerBase
{
    [HttpPost("lookup")]
    public async Task<IActionResult> Lookup([FromBody] BapiInspectorLookupRequest body, CancellationToken ct)
    {
        var result = await BapiInspectorHelper.LookupAsync(sapServerClient, audit, body.FunctionName, GetUserId(), GetUsername(), GetIpAddress(), ct);
        return Ok(ApiResponse<Dictionary<string, object?>?>.Ok(result));
    }
}
