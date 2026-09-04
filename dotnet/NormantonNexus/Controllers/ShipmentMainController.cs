using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Shipping (outbound) lifecycle core — Logistics Sub-phase 8a.1. Port of
/// the CRUD/lifecycle subset of routes/shipmentmain.js — see
/// ShipmentHelper's own header comment for exactly what's excluded and
/// deferred to later sub-slices. Mounted at api/shipmentmain, matching
/// Node's own route exactly. No blanket department/permission gate at the
/// class level — Node's own mount is requireLogin-only, with LOG_PLANNING
/// (or, for mark-collected-bulk, LOG_PLANNING/WAREHOUSE_OP) required per
/// action, mirrored here action-by-action.
/// </summary>
[Route("api/shipmentmain")]
public sealed class ShipmentMainController(
    INexusOperationsDb nexusOperationsDb, IOptions<LogisticsOptions> logisticsOptions, IDataChangeLogService dataChangeLog) : NexusControllerBase
{
    [HttpGet("queue/{mode}")]
    public async Task<IActionResult> GetQueue(string mode, CancellationToken ct)
    {
        var rows = await ShipmentHelper.GetQueueAsync(nexusOperationsDb, logisticsOptions, mode, ct);
        return Ok(ApiResponse<IReadOnlyList<ShipmentRow>>.Ok(rows));
    }

    [HttpPost("mark-collected-bulk")]
    [Authorize(Policy = "Perm:LOG_PLANNING,WAREHOUSE_OP")]
    public async Task<IActionResult> MarkCollectedBulk([FromBody] MarkCollectedBulkRequest body, CancellationToken ct)
    {
        var outcome = await ShipmentHelper.MarkCollectedBulkAsync(nexusOperationsDb, body.ShipmentIds, body.Description, GetUsername(), ct);
        if (outcome.Completed.Count == 0)
            return StatusCode(409, new ApiResponse<BulkActionOutcome>(false, outcome, new ApiError("CONFLICT", "No shipments were updated.")));
        return Ok(ApiResponse<BulkActionOutcome>.Ok(outcome));
    }

    [HttpPost("update-planned-collection")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> UpdatePlannedCollection([FromBody] UpdatePlannedCollectionRequest body, CancellationToken ct)
    {
        await ShipmentHelper.UpdatePlannedCollectionAsync(nexusOperationsDb, dataChangeLog, body.ShipmentIds, body.Date, GetUsername(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("events")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> WriteEvents([FromBody] WriteShipmentEventsRequest body, CancellationToken ct)
    {
        await ShipmentHelper.WriteEventsAsync(nexusOperationsDb, body.Events, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("cancel")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> Cancel([FromBody] BulkShipmentIdsRequest body, CancellationToken ct)
    {
        var updated = await ShipmentHelper.CancelAsync(nexusOperationsDb, body.ShipmentIds, ct);
        return Ok(ApiResponse<object>.Ok(new { updated }));
    }

    [HttpPost("{shipmentId:long}/mark-collected")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> MarkCollected(long shipmentId, CancellationToken ct)
    {
        await ShipmentHelper.MarkCollectedAsync(nexusOperationsDb, shipmentId, GetUsername(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("{shipmentId:long}/mark-delivered")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> MarkDelivered(long shipmentId, [FromBody] MarkDeliveredRequest body, CancellationToken ct)
    {
        await ShipmentHelper.MarkDeliveredAsync(nexusOperationsDb, shipmentId, body.ActualDelivery, GetUsername(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("mark-delivered-bulk")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> MarkDeliveredBulk([FromBody] MarkDeliveredBulkRequest body, CancellationToken ct)
    {
        var outcome = await ShipmentHelper.MarkDeliveredBulkAsync(nexusOperationsDb, body.ShipmentIds, body.ActualDelivery, GetUsername(), ct);
        if (outcome.Completed.Count == 0)
            return StatusCode(409, new ApiResponse<BulkActionOutcome>(false, outcome, new ApiError("CONFLICT", "No shipments were updated.")));
        return Ok(ApiResponse<BulkActionOutcome>.Ok(outcome));
    }

    [HttpPost("mark-booked")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> MarkBooked([FromBody] MarkBookedRequest body, CancellationToken ct)
    {
        var result = await ShipmentHelper.MarkBookedAsync(nexusOperationsDb, body, ct);
        return Ok(ApiResponse<MarkBookedResult>.Ok(result));
    }

    [HttpPost("unbook")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> Unbook([FromBody] BulkShipmentIdsRequest body, CancellationToken ct)
    {
        var outcome = await ShipmentHelper.UnbookAsync(nexusOperationsDb, body.ShipmentIds, GetUsername(), ct);
        return Ok(ApiResponse<BulkActionOutcome>.Ok(outcome));
    }

    [HttpPost("create-from-deliveries")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> CreateFromDeliveries([FromBody] CreateFromDeliveriesRequest body, CancellationToken ct)
    {
        var result = await ShipmentHelper.CreateFromDeliveriesAsync(nexusOperationsDb, logisticsOptions, dataChangeLog, body, GetUsername(), ct);
        return StatusCode(201, ApiResponse<CreateShipmentResult>.Ok(result));
    }

    [HttpPost("create-manual")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> CreateManual([FromBody] CreateManualShipmentRequest body, CancellationToken ct)
    {
        var result = await ShipmentHelper.CreateManualAsync(nexusOperationsDb, logisticsOptions, dataChangeLog, body, GetUsername(), ct);
        return StatusCode(201, ApiResponse<CreateManualShipmentResult>.Ok(result));
    }

    [HttpGet("{shipmentId:long}/details")]
    public async Task<IActionResult> GetDetails(long shipmentId, CancellationToken ct)
    {
        var result = await ShipmentHelper.GetDetailsAsync(nexusOperationsDb, shipmentId, ct);
        return Ok(ApiResponse<ShipmentDetailResult>.Ok(result));
    }

    [HttpDelete("{shipmentId:long}/deliveries/{deliveryId:long}")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> RemoveDelivery(long shipmentId, long deliveryId, CancellationToken ct)
    {
        var result = await ShipmentHelper.RemoveDeliveryAsync(nexusOperationsDb, shipmentId, deliveryId, ct);
        return Ok(ApiResponse<RemoveDeliveryResult>.Ok(result));
    }

    [HttpPost("{shipmentId:long}/deliveries")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> AddDeliveries(long shipmentId, [FromBody] AddDeliveriesToShipmentRequest body, CancellationToken ct)
    {
        await ShipmentHelper.AddDeliveriesAsync(nexusOperationsDb, shipmentId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPatch("{shipmentId:long}/status-dates")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> UpdateStatusDates(long shipmentId, [FromBody] UpdateStatusDatesRequest body, CancellationToken ct)
    {
        await ShipmentHelper.UpdateStatusDatesAsync(nexusOperationsDb, shipmentId, body, GetUsername(), ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPatch("{shipmentId:long}/forwarder")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> UpdateForwarder(long shipmentId, [FromBody] UpdateForwarderRequestForShipment body, CancellationToken ct)
    {
        await ShipmentHelper.UpdateForwarderAsync(nexusOperationsDb, shipmentId, body.ForwarderId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpGet("search")]
    public async Task<IActionResult> Search(
        [FromQuery] string? shipmentRef, [FromQuery] string? deliveryNumber, [FromQuery] string? forwarder, [FromQuery] string? customer,
        [FromQuery] string? tracking, [FromQuery] string? dateField, [FromQuery] DateTime? dateFrom, [FromQuery] DateTime? dateTo, CancellationToken ct)
    {
        var query = new ShipmentSearchQuery(shipmentRef, deliveryNumber, forwarder, customer, tracking, dateField, dateFrom, dateTo);
        var rows = await ShipmentHelper.SearchAsync(nexusOperationsDb, query, ct);
        return Ok(ApiResponse<IReadOnlyList<ShipmentSearchRow>>.Ok(rows));
    }

    [HttpGet("{shipmentId:long}/events")]
    public async Task<IActionResult> GetEvents(long shipmentId, CancellationToken ct)
    {
        var rows = await ShipmentHelper.GetEventsAsync(nexusOperationsDb, shipmentId, ct);
        return Ok(ApiResponse<IReadOnlyList<ShipmentEventRow>>.Ok(rows));
    }

    // ── Sub-phase 8a.2: manual cargo lines + create-folder ────────────

    [HttpGet("{shipmentId:long}/manual-cargo")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> GetManualCargo(long shipmentId, CancellationToken ct)
    {
        var rows = await ShipmentManualCargoHelper.GetCargoAsync(nexusOperationsDb, shipmentId, ct);
        return Ok(ApiResponse<IReadOnlyList<ManualCargoItemRow>>.Ok(rows));
    }

    [HttpPost("{shipmentId:long}/manual-cargo")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> CreateManualCargo(long shipmentId, [FromBody] CreateManualCargoItemRequest body, CancellationToken ct)
    {
        await ShipmentManualCargoHelper.CreateAsync(nexusOperationsDb, shipmentId, body, GetUsername(), ct);
        return StatusCode(201, ApiResponse<object?>.Ok(null));
    }

    [HttpPatch("manual-cargo/{cargoId:int}")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> UpdateManualCargo(int cargoId, [FromBody] UpdateManualCargoItemRequest body, CancellationToken ct)
    {
        await ShipmentManualCargoHelper.UpdateAsync(nexusOperationsDb, cargoId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("manual-cargo/{cargoId:int}")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> DeleteManualCargo(int cargoId, CancellationToken ct)
    {
        await ShipmentManualCargoHelper.DeleteAsync(nexusOperationsDb, cargoId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("{shipmentId:long}/create-folder")]
    [Authorize(Policy = "Perm:LOG_PLANNING")]
    public async Task<IActionResult> CreateFolder(long shipmentId, CancellationToken ct)
    {
        var result = await ShipmentManualCargoHelper.CreateFolderAsync(nexusOperationsDb, logisticsOptions, shipmentId, ct);
        return Ok(ApiResponse<CreateShipmentFolderResult>.Ok(result));
    }
}
