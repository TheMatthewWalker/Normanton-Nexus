using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Admin;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// SQL Console — a genuinely missing Admin tile found by a later gap audit
/// against the Node tile inventory, not a deliberate deferral (distinct from
/// DB Explorer, already ported in Phase 9, which only browses schema/data —
/// this runs arbitrary SQL). Port of routes/sqlqueries.js's POST /sql/query.
/// Node itself mounts this bare at /sql (requireLogin only — any logged-in
/// user, since it also serves plain SELECTs for a few legacy department
/// data-browser pages this migration never ported, per
/// SqlConsoleQueryRequest's own header comment); this port mounts it under
/// api/admin/sql instead, matching every other Admin sub-controller's own
/// api/admin/* namespace, and tightens the gate to Role:admin — the only
/// real consumer this migration builds is the Admin tile's own SQL Console
/// UI, and the destructive-keyword bypass is still superadmin-only exactly
/// as in Node.
/// </summary>
[Route("api/admin/sql")]
[Authorize(Policy = "Role:" + NexusRoles.Admin)]
public sealed class SqlConsoleController(INexusDb nexusDb, IAuditLogger audit) : NexusControllerBase
{
    [HttpPost("query")]
    public async Task<IActionResult> RunQuery([FromBody] SqlConsoleQueryRequest? body, CancellationToken ct) =>
        Ok(ApiResponse<SqlConsoleQueryResult>.Ok(await SqlConsoleHelper.RunQueryAsync(
            nexusDb, audit, body?.Query, GetRole() == NexusRoles.Superadmin, GetUsername(), GetIpAddress(), ct)));
}
