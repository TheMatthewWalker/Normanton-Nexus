using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Sales;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Sales department — Customer Standard Instructions + Schedule Agreement
/// Waterfall. Thin JSON API layer over SalesHelper. See
/// ProductionScheduleController for the shared Production Schedule tile
/// (also on the Sales page, but not Sales-specific logic).
/// </summary>
[Route("api/sales")]
[Authorize(Policy = "Dept:" + NexusDepartments.Sales)]
public sealed class SalesController(INexusOperationsDb nexusOperationsDb, ISapServerClient sapServerClient) : NexusControllerBase
{
    [HttpGet("customer-instructions")]
    public async Task<IActionResult> ListCustomerInstructions(CancellationToken ct)
    {
        var rows = await SalesHelper.ListCustomerInstructionsAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<CustomerInstructionRow>>.Ok(rows));
    }

    [HttpPut("customer-instructions/{customer}")]
    [Authorize(Policy = "Perm:" + SalesHelper.FnCustomerInstructions)]
    public async Task<IActionResult> SaveCustomerInstruction(string customer, [FromBody] CustomerInstructionSaveRequest body, CancellationToken ct)
    {
        await SalesHelper.SaveCustomerInstructionAsync(nexusOperationsDb, customer, body, GetUsername(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("customer-instructions/bulk-import")]
    [Authorize(Policy = "Perm:" + SalesHelper.FnCustomerInstructions)]
    public async Task<IActionResult> BulkImportCustomerInstructions([FromBody] BulkImportCustomerInstructionsRequest body, CancellationToken ct)
    {
        var result = await SalesHelper.BulkImportCustomerInstructionsAsync(nexusOperationsDb, body, GetUsername(), ct);
        return Ok(ApiResponse<BulkImportResult>.Ok(result));
    }

    [HttpDelete("customer-instructions/{customer}")]
    [Authorize(Policy = "Perm:" + SalesHelper.FnCustomerInstructions)]
    public async Task<IActionResult> DeleteCustomerInstruction(string customer, CancellationToken ct)
    {
        await SalesHelper.DeleteCustomerInstructionAsync(nexusOperationsDb, customer, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpGet("schedule-waterfall")]
    public async Task<IActionResult> ScheduleWaterfall([FromQuery] ScheduleWaterfallQuery query, CancellationToken ct)
    {
        var rows = await SalesHelper.GetScheduleWaterfallAsync(sapServerClient, query, GetUserId(), ct);
        return Ok(ApiResponse<IReadOnlyList<ScheduleWaterfallRow>>.Ok(rows));
    }
}
