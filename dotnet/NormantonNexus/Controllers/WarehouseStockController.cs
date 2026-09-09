using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Warehouse;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Stock Management / Transfer Orders / Transfer Requirements (LT04) —
/// port of routes/sap.js's `/warehouse/*` proxy routes (mounted at
/// `/api/sap` in Node; kept at `api/warehouse` here instead, matching
/// SapServer's own route naming for these exact same actions rather than
/// inventing a `sap` segment Normanton-Nexus doesn't otherwise use).
/// Genuinely missing until Phase 10's frontend catch-up — Phase 7's own
/// status notes flagged "sap.js's general Stock Transfer tool... NOT
/// scoped into 7a-7d" but this was never picked back up until now. See
/// WarehouseStockHelper's own header comment for the full permission-gate
/// reasoning (matches Node's routes/sap.js exactly, not invented).
///
/// Individual [FromQuery] parameters rather than a bound query DTO,
/// matching ShipmentMainController.Search's own established convention —
/// sidesteps the null-complex-type-binding class of gotcha entirely rather
/// than needing a defensive `query ??= new(...)` the way SapServer's own
/// Web API 2 controllers do.
/// </summary>
[Route("api/warehouse")]
[Authorize(Policy = "Dept:" + NexusDepartments.Warehouse)]
public sealed class WarehouseStockController(INexusOperationsDb nexusOperationsDb, ISapServerClient sapServerClient) : NexusControllerBase
{
    [HttpGet("stock")]
    public async Task<IActionResult> GetStock(
        [FromQuery] string? material, [FromQuery] string? storageType, [FromQuery] string? excludeStorageType,
        [FromQuery] string? bin, [FromQuery] string? batch, [FromQuery] string? storageLocation,
        [FromQuery] string? stockCategory, [FromQuery] string? profitCentre, CancellationToken ct)
    {
        var query = new StockQuery(material, storageType, excludeStorageType, bin, batch, storageLocation, stockCategory, profitCentre);
        var rows = await WarehouseStockHelper.GetStockAsync(sapServerClient, GetUserId(), query, ct);
        return Ok(ApiResponse<IReadOnlyList<WarehouseStockRow>>.Ok(rows));
    }

    [HttpGet("open-transfer-requirements")]
    public async Task<IActionResult> GetOpenTransferRequirements(
        [FromQuery] string? mrpController, [FromQuery] string? material, [FromQuery] string? storageLocation, [FromQuery] string? createdBy, CancellationToken ct)
    {
        var query = new OpenTransferRequirementsQuery(mrpController, material, storageLocation, createdBy);
        var rows = await WarehouseStockHelper.GetOpenTransferRequirementsAsync(sapServerClient, GetUserId(), query, ct);
        return Ok(ApiResponse<IReadOnlyList<OpenTransferRequirementRow>>.Ok(rows));
    }

    [HttpGet("bin-storage-types")]
    public async Task<IActionResult> GetBinStorageTypes([FromQuery] string bin, CancellationToken ct)
    {
        var rows = await WarehouseStockHelper.GetBinStorageTypesAsync(sapServerClient, GetUserId(), bin, ct);
        return Ok(ApiResponse<IReadOnlyList<string>>.Ok(rows));
    }

    [HttpGet("tr-cleanup-candidates")]
    public async Task<IActionResult> GetTrCleanupCandidates(CancellationToken ct)
    {
        var rows = await WarehouseStockHelper.GetTrCleanupCandidatesAsync(sapServerClient, GetUserId(), ct);
        return Ok(ApiResponse<IReadOnlyList<TrCleanupCandidateRow>>.Ok(rows));
    }

    [HttpPost("transfer-order")]
    public async Task<IActionResult> CreateTransferOrder([FromBody] CreateTransferOrderRequest body, CancellationToken ct)
    {
        var result = await WarehouseStockHelper.CreateTransferOrderAsync(nexusOperationsDb, sapServerClient, GetUserId(), body, ct);
        return Ok(ApiResponse<CreateTransferOrderResponse>.Ok(result));
    }

    [HttpPost("transfer-order-bulk")]
    public async Task<IActionResult> CreateTransferOrdersBulk([FromBody] BulkTransferOrderRequest body, CancellationToken ct)
    {
        var results = await WarehouseStockHelper.CreateTransferOrdersBulkAsync(nexusOperationsDb, sapServerClient, GetUserId(), body.Items, ct);
        return Ok(ApiResponse<IReadOnlyList<BulkItemResult<CreateTransferOrderResponse>>>.Ok(results));
    }

    [HttpPost("create-lt04")]
    public async Task<IActionResult> CreateLt04([FromBody] CreateLt04Request body, CancellationToken ct)
    {
        var result = await WarehouseStockHelper.CreateLt04Async(nexusOperationsDb, sapServerClient, GetUserId(), body, ct);
        return Ok(ApiResponse<BdcResponse>.Ok(result));
    }

    [HttpPost("create-lt04-bulk")]
    public async Task<IActionResult> CreateLt04Bulk([FromBody] BulkCreateLt04Request body, CancellationToken ct)
    {
        var results = await WarehouseStockHelper.CreateLt04BulkAsync(nexusOperationsDb, sapServerClient, GetUserId(), body.Items, ct);
        return Ok(ApiResponse<IReadOnlyList<BulkItemResult<BdcResponse>>>.Ok(results));
    }

    [HttpPost("delete-tr")]
    [Authorize(Policy = "Perm:LOG_SUPER")]
    public async Task<IActionResult> DeleteTr([FromBody] DeleteTrRequest body, CancellationToken ct)
    {
        var result = await WarehouseStockHelper.DeleteTrAsync(sapServerClient, GetUserId(), body, ct);
        return Ok(ApiResponse<BdcResponse>.Ok(result));
    }

    [HttpPost("stock-adjustment")]
    [Authorize(Policy = "Perm:LOG_SUPER")]
    public async Task<IActionResult> CreateStockAdjustment([FromBody] StockAdjustmentRequest body, CancellationToken ct)
    {
        var result = await WarehouseStockHelper.CreateStockAdjustmentAsync(sapServerClient, GetUserId(), body, ct);
        return Ok(ApiResponse<StockAdjustmentResponse>.Ok(result));
    }
}
