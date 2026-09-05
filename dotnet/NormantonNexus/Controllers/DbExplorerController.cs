using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Admin;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// DB Explorer — Phase 9, superadmin-only SSMS-lite schema browser. Port of
/// routes/dbexplorer.js, mounted at api/admin/dbexplorer per server.js.
/// Every action is Role:superadmin — stricter than UserAdminController's
/// blanket Role:admin class-level gate, matching Node's own per-file
/// requireSuperadmin (not the api/admin mount's requireRole('admin')).
/// </summary>
[Route("api/admin/dbexplorer")]
[Authorize(Policy = "Role:superadmin")]
public sealed class DbExplorerController(INexusDb nexusDb, IAuditLogger audit) : NexusControllerBase
{
    [HttpGet("databases")]
    public async Task<IActionResult> ListDatabases(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<DatabaseInfoRow>>.Ok(await DbExplorerHelper.ListDatabasesAsync(nexusDb, ct)));

    [HttpGet("{database}/tables")]
    public async Task<IActionResult> ListTables(string database, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<TableInfoRow>>.Ok(await DbExplorerHelper.ListTablesAsync(nexusDb, database, ct)));

    [HttpGet("{database}/{schema}/{table}/columns")]
    public async Task<IActionResult> ListColumns(string database, string schema, string table, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<ColumnInfoRow>>.Ok(await DbExplorerHelper.ListColumnsAsync(nexusDb, database, schema, table, ct)));

    [HttpGet("{database}/{schema}/{table}/constraints")]
    public async Task<IActionResult> GetConstraints(string database, string schema, string table, CancellationToken ct) =>
        Ok(ApiResponse<TableConstraintsResult>.Ok(await DbExplorerHelper.GetConstraintsAsync(nexusDb, database, schema, table, ct)));

    [HttpGet("{database}/{schema}/{table}/preview")]
    public async Task<IActionResult> PreviewRows(string database, string schema, string table, [FromQuery] int? top, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<Dictionary<string, object?>>>.Ok(
            await DbExplorerHelper.PreviewRowsAsync(nexusDb, audit, database, schema, table, top, GetUsername(), GetIpAddress(), ct)));
}
