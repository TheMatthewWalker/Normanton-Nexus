using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Vendor Consignment Tracker — Logistics Sub-phase 8e.1 (DB/algorithm
/// core). Port of the non-SAP/non-PDF subset of routes/consignment.js —
/// see ConsignmentTrackerHelper's own header comment for what's
/// deliberately excluded (SAP GR sync, stock-snapshot refresh, declaration
/// PDF — all Sub-phase 8e.2) and for the reassignment-plan functions that
/// exist but have no route here, matching Node exactly. Mounted at
/// api/consignment, matching Node's own mount.
/// </summary>
[Route("api/consignment")]
public sealed class ConsignmentTrackerController(INexusOperationsDb nexusOperationsDb) : NexusControllerBase
{
    [HttpGet("vendors")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> ListVendors(CancellationToken ct)
    {
        var rows = await ConsignmentTrackerHelper.ListVendorsAsync(nexusOperationsDb, ct);
        return Ok(ApiResponse<IReadOnlyList<ConsignmentVendorRow>>.Ok(rows));
    }

    [HttpGet("vendors/{vendorId:long}")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> GetVendor(long vendorId, CancellationToken ct)
    {
        var detail = await ConsignmentTrackerHelper.GetVendorDetailAsync(nexusOperationsDb, vendorId, ct);
        if (detail is null) return NotFound(ApiResponse<object?>.Fail("NOT_FOUND", "Vendor not found."));
        return Ok(ApiResponse<ConsignmentVendorDetail>.Ok(detail));
    }

    [HttpPut("vendors/{vendorId:long}/config")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> UpsertVendorConfig(long vendorId, [FromBody] UpsertConsignmentVendorConfigRequest body, CancellationToken ct)
    {
        var result = await ConsignmentTrackerHelper.UpsertVendorConfigAsync(nexusOperationsDb, vendorId, body, GetUsername(), ct);
        return Ok(ApiResponse<ConsignmentVendorRow>.Ok(result));
    }

    [HttpGet("vendors/{vendorId:long}/balance")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> GetBalance(long vendorId, CancellationToken ct)
    {
        var result = await ConsignmentTrackerHelper.GetVendorBalanceAsync(nexusOperationsDb, vendorId, ct);
        if (result is null) return NotFound(ApiResponse<object?>.Fail("NOT_FOUND", "Vendor not found."));
        return Ok(ApiResponse<VendorBalanceResult>.Ok(result));
    }

    [HttpGet("vendors/{vendorId:long}/deliveries")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> ListDeliveries(long vendorId, [FromQuery] string? material, CancellationToken ct)
    {
        var rows = await ConsignmentTrackerHelper.ListDeliveriesAsync(nexusOperationsDb, vendorId, material, ct);
        return Ok(ApiResponse<IReadOnlyList<ConsignmentDeliveryRow>>.Ok(rows));
    }

    [HttpPost("vendors/{vendorId:long}/deliveries")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> AddManualDelivery(long vendorId, [FromBody] AddManualConsignmentDeliveryRequest body, CancellationToken ct)
    {
        var deliveryId = await ConsignmentTrackerHelper.AddManualDeliveryAsync(nexusOperationsDb, vendorId, body, GetUsername(), ct);
        return Ok(ApiResponse<object>.Ok(new { deliveryId }));
    }

    [HttpPost("vendors/{vendorId:long}/deliveries/csv-import")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> ImportDeliveriesCsv(long vendorId, [FromBody] CsvImportDeliveriesRequest body, CancellationToken ct)
    {
        var result = await ConsignmentTrackerHelper.ImportDeliveriesCsvAsync(nexusOperationsDb, vendorId, body, GetUsername(), ct);
        return Ok(ApiResponse<CsvImportResult>.Ok(result));
    }

    [HttpPut("deliveries/{deliveryId:long}")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> UpdateDelivery(long deliveryId, [FromBody] UpdateConsignmentDeliveryRequest body, CancellationToken ct)
    {
        await ConsignmentTrackerHelper.UpdateDeliveryAsync(nexusOperationsDb, deliveryId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("vendors/{vendorId:long}/declarations/propose")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> ProposeDeclaration(long vendorId, [FromBody] ProposeDeclarationRequest body, CancellationToken ct)
    {
        var result = await ConsignmentTrackerHelper.ProposeDeclarationAsync(nexusOperationsDb, vendorId, body, ct);
        return Ok(ApiResponse<AllocationProposalResult>.Ok(result));
    }

    [HttpPost("vendors/{vendorId:long}/declarations")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> CreateDeclaration(long vendorId, [FromBody] CreateDeclarationRequest body, CancellationToken ct)
    {
        var declarationId = await ConsignmentTrackerHelper.CreateDeclarationAsync(nexusOperationsDb, vendorId, body, GetUsername(), ct);
        var declaration = await ConsignmentTrackerHelper.GetDeclarationAsync(nexusOperationsDb, declarationId, ct);
        return Ok(ApiResponse<ConsignmentDeclarationDetail?>.Ok(declaration));
    }

    [HttpGet("vendors/{vendorId:long}/declarations")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> ListVendorDeclarations(long vendorId, CancellationToken ct)
    {
        var rows = await ConsignmentTrackerHelper.ListDeclarationsAsync(nexusOperationsDb, vendorId, ct);
        return Ok(ApiResponse<IReadOnlyList<ConsignmentDeclarationSummaryRow>>.Ok(rows));
    }

    [HttpGet("declarations/{declarationId:long}")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> GetDeclaration(long declarationId, CancellationToken ct)
    {
        var declaration = await ConsignmentTrackerHelper.GetDeclarationAsync(nexusOperationsDb, declarationId, ct);
        if (declaration is null) return NotFound(ApiResponse<object?>.Fail("NOT_FOUND", "Declaration not found."));
        return Ok(ApiResponse<ConsignmentDeclarationDetail>.Ok(declaration));
    }

    [HttpPut("declarations/{declarationId:long}/lines")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> SetDeclarationLines(long declarationId, [FromBody] SetDeclarationLinesRequest body, CancellationToken ct)
    {
        await ConsignmentTrackerHelper.SetDeclarationLinesAsync(nexusOperationsDb, declarationId, body, ct);
        var declaration = await ConsignmentTrackerHelper.GetDeclarationAsync(nexusOperationsDb, declarationId, ct);
        return Ok(ApiResponse<ConsignmentDeclarationDetail?>.Ok(declaration));
    }

    [HttpPost("declarations/{declarationId:long}/confirm")]
    [Authorize(Policy = "Perm:VENDOR_CONSIGNMENT")]
    public async Task<IActionResult> ConfirmDeclaration(long declarationId, [FromBody] ConfirmDeclarationRequest body, CancellationToken ct)
    {
        var result = await ConsignmentTrackerHelper.ConfirmDeclarationAsync(nexusOperationsDb, declarationId, body, GetUsername(), ct);
        return Ok(ApiResponse<ConsignmentDeclarationDetail>.Ok(result));
    }

    [HttpPost("declarations/{declarationId:long}/cancel")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> CancelDeclaration(long declarationId, CancellationToken ct)
    {
        await ConsignmentTrackerHelper.CancelDeclarationAsync(nexusOperationsDb, declarationId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }
}
