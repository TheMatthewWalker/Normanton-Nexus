using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.ProductionSchedule;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Production Schedule — shared between the Sales and Production department
/// pages (Node: routes/productionschedule.js, mounted for both). View
/// access is department-gated "production OR sales"; the comment/ETA save
/// requires Perm:PROD_SCHEDULE_EDIT (a new per-tile code — see the
/// migration for how holders of either legacy PROD_SUPERVISOR or
/// SALES_SUPERVISOR keep access).
/// </summary>
[Route("api/production-schedule")]
[Authorize(Policy = "Dept:" + NexusDepartments.Production + "," + NexusDepartments.Sales)]
public sealed class ProductionScheduleController(INexusOperationsDb nexusOperationsDb) : NexusControllerBase
{
    [HttpGet]
    public async Task<IActionResult> GetSchedule(CancellationToken ct)
    {
        var result = await ProductionScheduleHelper.GetProductionScheduleAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<ProductionScheduleListResponse>.Ok(result));
    }

    [HttpGet("arrears")]
    public async Task<IActionResult> GetArrears(CancellationToken ct)
    {
        var rows = await ProductionScheduleHelper.GetProductionArrearsAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<ProductionArrearsRow>>.Ok(rows));
    }

    [HttpPut("{referenceDocument}/{item}")]
    [Authorize(Policy = "Perm:" + ProductionScheduleHelper.FnScheduleEdit)]
    public async Task<IActionResult> SaveComment(string referenceDocument, string item, [FromBody] ProductionScheduleCommentSaveRequest body, CancellationToken ct)
    {
        await ProductionScheduleHelper.UpsertCommentAsync(nexusOperationsDb, referenceDocument, item, body, GetUsername(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpGet("kpi")]
    public async Task<IActionResult> GetKpiHistory(CancellationToken ct)
    {
        var rows = await ProductionScheduleHelper.GetOtifKpiHistoryAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<OtifKpiRow>>.Ok(rows));
    }

    [HttpGet("kpi/late")]
    public async Task<IActionResult> GetKpiLateList(CancellationToken ct)
    {
        var rows = await ProductionScheduleHelper.GetOtifLateListAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<OtifLateRow>>.Ok(rows));
    }
}
