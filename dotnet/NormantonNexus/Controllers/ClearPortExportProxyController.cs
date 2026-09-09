using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Services;

namespace NormantonNexus.Controllers;

/// <summary>
/// ClearPort raw CDS export proxy — Logistics Sub-phase 8c.4, the last
/// slice of Phase 8 (Logistics). Port of routes/clearportexport.js,
/// mounted at api/clearport (Node's exact mount — requireLogin only, no
/// requirePermission call on this route either, same "no extra permission
/// gate beyond being logged in" precedent 8c.3's booking-creation route
/// already set).
///
/// Deliberately a SEPARATE client (IClearPortExportProxyClient) from
/// Sub-phase 8a.5c's IClearPortClient — not a reuse of CreateExportAsync —
/// because the two authenticate the identical /v1/cds/exports endpoint
/// differently (X-API-Key vs Authorization: Bearer), a real, confirmed
/// inconsistency already present in the Node app itself (two different
/// route files, two different auth conventions, same CLEARPORT_API_TOKEN
/// value) that this port preserves rather than silently unifying. See
/// ClearPortExportProxyClient's own header comment for the full reasoning.
/// </summary>
[Route("api/clearport")]
public sealed class ClearPortExportProxyController(IClearPortExportProxyClient client) : NexusControllerBase
{
    [HttpPost("exports")]
    public async Task<IActionResult> Exports([FromBody] JsonElement payload, CancellationToken ct)
    {
        ClearPortExportProxyHelper.ValidatePayload(payload);
        var result = await client.SubmitAsync(payload, ct);
        return StatusCode(201, new { success = true, clearport = result });
    }
}
