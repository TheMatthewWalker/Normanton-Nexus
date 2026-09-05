using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Finance;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Finance department — GL Account Groups + the three SAP costing proxies
/// (Material Costing, Actual Costs, Profit Center Data tiles). See
/// StockCountController for the separate Stock Adjustments tile (its own
/// controller since it's built on the shared Stock Count feature, not
/// Finance-exclusive logic).
/// </summary>
[Route("api/finance")]
[Authorize(Policy = "Dept:" + NexusDepartments.Finance)]
public sealed class FinanceController(INexusOperationsDb nexusOperationsDb, ISapServerClient sapServerClient) : NexusControllerBase
{
    [HttpGet("gl-groups")]
    public async Task<IActionResult> ListGlGroups(CancellationToken ct)
    {
        var rows = await FinanceHelper.ListGlGroupsAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<GlGroupRow>>.Ok(rows));
    }

    [HttpPost("gl-groups")]
    [Authorize(Policy = "Perm:" + FinanceHelper.FnGlGroupsManage)]
    public async Task<IActionResult> CreateGlGroup([FromBody] GlGroupSaveRequest body, CancellationToken ct)
    {
        var id = await FinanceHelper.CreateGlGroupAsync(nexusOperationsDb, body, ct);
        return StatusCode(201, ApiResponse<object>.Ok(new { id }));
    }

    [HttpPut("gl-groups/{id:int}")]
    [Authorize(Policy = "Perm:" + FinanceHelper.FnGlGroupsManage)]
    public async Task<IActionResult> UpdateGlGroup(int id, [FromBody] GlGroupSaveRequest body, CancellationToken ct)
    {
        await FinanceHelper.UpdateGlGroupAsync(nexusOperationsDb, id, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("gl-groups/{id:int}")]
    [Authorize(Policy = "Perm:" + FinanceHelper.FnGlGroupsManage)]
    public async Task<IActionResult> DeleteGlGroup(int id, CancellationToken ct)
    {
        await FinanceHelper.DeleteGlGroupAsync(nexusOperationsDb, id, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("cost-sheet")]
    public async Task<IActionResult> CostSheet([FromBody] CostSheetRequest body, CancellationToken ct)
    {
        var rows = await FinanceHelper.GetCostSheetAsync(sapServerClient, body, GetUserId(), ct);
        return Ok(ApiResponse<IReadOnlyList<CostSheetRow>>.Ok(rows));
    }

    [HttpPost("costing/period-balance")]
    public async Task<IActionResult> PeriodBalance([FromBody] PeriodBalanceRequest body, CancellationToken ct)
    {
        var rows = await FinanceHelper.GetPeriodBalanceAsync(sapServerClient, body, GetUserId(), ct);
        return Ok(ApiResponse<IReadOnlyList<PeriodBalanceRow>>.Ok(rows));
    }

    [HttpPost("costing/profit-center")]
    public async Task<IActionResult> ProfitCenter([FromBody] ProfitCenterRequest body, CancellationToken ct)
    {
        var rows = await FinanceHelper.GetProfitCenterAsync(sapServerClient, body, GetUserId(), ct);
        return Ok(ApiResponse<IReadOnlyList<ProfitCenterRow>>.Ok(rows));
    }
}
