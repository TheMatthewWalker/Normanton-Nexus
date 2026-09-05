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
/// Purchasing/Performance — Logistics Sub-phase 8b.1 (read-only dashboard
/// routes) + 8b.2 (vendor master data, demand adjustments, Isopar readings/
/// planning-rate/stock-risk) + 8b.3 (order suggestion engine) + 8b.4 (inbound
/// shipment tracking — filesystem-only document handling; the real-SAP
/// goods-receipt write is deferred to 8b.7 — see dotnet/CLAUDE.md). Port of
/// the corresponding routes in routes/performance.js, mounted at
/// api/performance matching Node's own mount. requireLogin-only at Node's
/// mount point maps to this base class's [Authorize]; every route below
/// additionally carries its own real Node permission gate.
/// </summary>
[Route("api/performance")]
public sealed class PerformanceController(INexusDb nexusDb, INexusOperationsDb nexusOperationsDb, IOptions<LogisticsOptions> logisticsOptions) : NexusControllerBase
{
    [HttpGet("refresh-log")]
    public async Task<IActionResult> GetRefreshLog(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<RefreshLogRow>>.Ok(await PerformanceDashboardHelper.GetRefreshLogAsync(nexusDb, ct)));

    [HttpGet("refresh-status")]
    public async Task<IActionResult> GetRefreshStatus(CancellationToken ct) =>
        Ok(ApiResponse<RefreshStatusResult>.Ok(await PerformanceDashboardHelper.GetRefreshStatusAsync(nexusDb, ct)));

    [HttpGet("value-metrics")]
    public async Task<IActionResult> GetValueMetrics(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<ValueMetricsDay>>.Ok(await PerformanceDashboardHelper.GetValueMetricsAsync(nexusOperationsDb, ct)));

    [HttpGet("otif-metrics")]
    public async Task<IActionResult> GetOtifMetrics(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<OtifMetricsDay>>.Ok(await PerformanceDashboardHelper.GetOtifMetricsAsync(nexusOperationsDb, ct)));

    [HttpGet("orderbook-summary")]
    public async Task<IActionResult> GetOrderBookSummary(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<OrderBookSummaryRow>>.Ok(await PerformanceDashboardHelper.GetOrderBookSummaryAsync(nexusOperationsDb, ct)));

    [HttpGet("orderbook-breakdown")]
    public async Task<IActionResult> GetOrderBookBreakdown(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<OrderBookBreakdownRow>>.Ok(await PerformanceDashboardHelper.GetOrderBookBreakdownAsync(nexusOperationsDb, ct)));

    [HttpPost("turns-valclass/refresh")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public IActionResult RefreshTurnsValClass() =>
        // runTurnsValClassRefresh (performancesync.js) is a SAP-pulling background job —
        // deferred to 8b.6's refresh-orchestration slice alongside the rest of performancesync.js.
        StatusCode(501, ApiResponse<object?>.Fail("NOT_IMPLEMENTED", "Turns/Valuation Class refresh is not yet ported — see Sub-phase 8b.6."));

    [HttpGet("turns-valclass/refresh-status")]
    [Authorize(Policy = "Perm:LOG_ADMIN,LOG_MRP,LOG_REPORTS")]
    public async Task<IActionResult> GetTurnsValClassRefreshStatus(CancellationToken ct) =>
        Ok(ApiResponse<RefreshStatusResult>.Ok(await PerformanceDashboardHelper.GetTurnsValClassRefreshStatusAsync(nexusDb, ct)));

    [HttpGet("turns-valclass")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> GetTurnsValClass([FromQuery] TurnsValClassQuery? query, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<TurnsValClassRow>>.Ok(await PerformanceDashboardHelper.GetTurnsValClassAsync(nexusOperationsDb, query ?? new TurnsValClassQuery(null, null, null, null, null, null, null, null), ct)));

    [HttpGet("turns-valclass/aggregates")]
    [Authorize(Policy = "Perm:LOG_ADMIN,LOG_MRP,LOG_REPORTS")]
    public async Task<IActionResult> GetTurnsValClassAggregates(CancellationToken ct) =>
        Ok(ApiResponse<TurnsValClassAggregates>.Ok(await PerformanceDashboardHelper.GetTurnsValClassAggregatesAsync(nexusOperationsDb, ct)));

    [HttpGet("turns-valclass/value-history")]
    [Authorize(Policy = "Perm:LOG_ADMIN,LOG_MRP,LOG_REPORTS")]
    public async Task<IActionResult> GetTurnsValClassValueHistory(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<StockValueHistoryPoint>>.Ok(await PerformanceDashboardHelper.GetStockValueHistoryAsync(nexusOperationsDb, ct)));

    [HttpGet("turns-valclass/value-by-price")]
    [Authorize(Policy = "Perm:LOG_ADMIN,LOG_MRP,LOG_REPORTS")]
    public async Task<IActionResult> GetTurnsValClassValueByPrice(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<StockValueByPriceBand>>.Ok(await PerformanceDashboardHelper.GetStockValueByPriceAsync(nexusOperationsDb, ct)));

    [HttpGet("turns-valclass/mrp-controllers")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> GetTurnsValClassMrpControllers(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<MrpControllerOption>>.Ok(await PerformanceDashboardHelper.GetMrpControllersAsync(nexusOperationsDb, ct)));

    [HttpGet("turns-valclass/valuation-classes")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> GetValuationClasses([FromQuery] string? materialType, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<ValuationClassCatalogRow>>.Ok(await PerformanceDashboardHelper.GetValuationClassesAsync(nexusOperationsDb, materialType, ct)));

    // ── Sub-phase 8b.2: Vendor master data (log.Vendor/log.VendorMaterial) ──

    [HttpGet("vendors")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> ListVendors(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<VendorRow>>.Ok(await VendorMasterDataHelper.ListVendorsAsync(nexusOperationsDb, ct)));

    [HttpPost("vendors")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> CreateVendor([FromBody] UpsertVendorRequest body, CancellationToken ct)
    {
        var vendorId = await VendorMasterDataHelper.CreateVendorAsync(nexusOperationsDb, body, ct);
        return Ok(ApiResponse<object>.Ok(new { vendorId }));
    }

    [HttpPut("vendors/{vendorId:long}")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> UpdateVendor(long vendorId, [FromBody] UpsertVendorRequest body, CancellationToken ct)
    {
        await VendorMasterDataHelper.UpdateVendorAsync(nexusOperationsDb, vendorId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("vendors/{vendorId:long}")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> DeleteVendor(long vendorId, CancellationToken ct)
    {
        await VendorMasterDataHelper.DeleteVendorAsync(nexusOperationsDb, vendorId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpGet("vendors/{vendorId:long}/materials")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> ListVendorMaterials(long vendorId, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<VendorMaterialAssignmentRow>>.Ok(await VendorMasterDataHelper.ListVendorMaterialsAsync(nexusOperationsDb, vendorId, ct)));

    [HttpPost("vendors/{vendorId:long}/materials")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> AddVendorMaterial(long vendorId, [FromBody] AddVendorMaterialRequest body, CancellationToken ct)
    {
        var vendorMaterialId = await VendorMasterDataHelper.AddVendorMaterialAsync(nexusOperationsDb, vendorId, body, ct);
        return Ok(ApiResponse<object>.Ok(new { vendorMaterialId }));
    }

    [HttpPut("vendors/{vendorId:long}/materials/{vendorMaterialId:long}")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> UpdateVendorMaterial(long vendorId, long vendorMaterialId, [FromBody] UpdateVendorMaterialRequest body, CancellationToken ct)
    {
        await VendorMasterDataHelper.UpdateVendorMaterialAsync(nexusOperationsDb, vendorMaterialId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("vendors/{vendorId:long}/materials/{vendorMaterialId:long}")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> DeleteVendorMaterial(long vendorId, long vendorMaterialId, CancellationToken ct)
    {
        await VendorMasterDataHelper.DeleteVendorMaterialAsync(nexusOperationsDb, vendorMaterialId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    // ── Sub-phase 8b.2: Demand adjustments (log.DemandAdjustment) ────────

    [HttpGet("demand-adjustments")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> ListDemandAdjustments(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<DemandAdjustmentRow>>.Ok(await VendorMasterDataHelper.ListDemandAdjustmentsForAdminAsync(nexusOperationsDb, ct)));

    [HttpPost("demand-adjustments")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> CreateDemandAdjustment([FromBody] UpsertDemandAdjustmentRequest body, CancellationToken ct)
    {
        var adjustmentId = await VendorMasterDataHelper.CreateDemandAdjustmentAsync(nexusOperationsDb, body, GetUsername(), ct);
        return Ok(ApiResponse<object>.Ok(new { adjustmentId }));
    }

    [HttpPut("demand-adjustments/{adjustmentId:long}")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> UpdateDemandAdjustment(long adjustmentId, [FromBody] UpsertDemandAdjustmentRequest body, CancellationToken ct)
    {
        await VendorMasterDataHelper.UpdateDemandAdjustmentAsync(nexusOperationsDb, adjustmentId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("demand-adjustments/{adjustmentId:long}")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> DeleteDemandAdjustment(long adjustmentId, CancellationToken ct)
    {
        await VendorMasterDataHelper.DeleteDemandAdjustmentAsync(nexusOperationsDb, adjustmentId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    // ── Sub-phase 8b.2: Isopar Tied Oil (log.IsoparMeterReading/log.IsoparPlanningRate) ──

    [HttpGet("isopar/readings")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> ListIsoparReadings([FromQuery] DateTime? from, [FromQuery] DateTime? to, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<IsoparReadingRow>>.Ok(await IsoparHelper.ListReadingsAsync(nexusOperationsDb, from, to, ct)));

    [HttpPost("isopar/readings")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> CreateIsoparReading([FromBody] CreateIsoparReadingRequest body, CancellationToken ct)
    {
        var readingId = await IsoparHelper.CreateReadingAsync(nexusOperationsDb, body, GetUsername(), ct);
        return Ok(ApiResponse<object>.Ok(new { readingId }));
    }

    [HttpPut("isopar/readings/{readingId:long}")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> UpdateIsoparReading(long readingId, [FromBody] UpdateIsoparReadingRequest body, CancellationToken ct)
    {
        await IsoparHelper.UpdateReadingAsync(nexusOperationsDb, readingId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("isopar/readings/{readingId:long}")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> DeleteIsoparReading(long readingId, CancellationToken ct)
    {
        await IsoparHelper.DeleteReadingAsync(nexusOperationsDb, readingId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpGet("isopar/stock-risk")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> GetIsoparStockRisk(CancellationToken ct) =>
        Ok(ApiResponse<IsoparStockRiskResult?>.Ok(await IsoparHelper.ComputeStockRiskAsync(nexusOperationsDb, ct)));

    [HttpGet("isopar/planning-rate")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> GetIsoparPlanningRate(CancellationToken ct) =>
        Ok(ApiResponse<IsoparPlanningRateResult>.Ok(await IsoparHelper.GetPlanningRateWithRecommendationAsync(nexusOperationsDb, ct)));

    [HttpPut("isopar/planning-rate")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> UpdateIsoparPlanningRate([FromBody] UpdateIsoparPlanningRateRequest body, CancellationToken ct)
    {
        var rateId = await IsoparHelper.UpdatePlanningRateAsync(nexusOperationsDb, body, GetUsername(), ct);
        return Ok(ApiResponse<object>.Ok(new { rateId }));
    }

    // ── Sub-phase 8b.3: Order suggestion engine (log.PurchaseOrderSuggestion) ──
    // create-po/regenerate-pdf (real SAP PO creation) are deferred to 8b.7.

    [HttpGet("order-suggestions")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> ListOrderSuggestions(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<VendorSuggestionGroup>>.Ok(await PurchaseOrderSuggestionHelper.ComputeOrderSuggestionsGroupedAsync(nexusOperationsDb, ct)));

    [HttpGet("order-suggestions/vendor/{vendorId:long}/build")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> GetVendorOrderBuild(long vendorId, CancellationToken ct) =>
        Ok(ApiResponse<VendorOrderBuildResult>.Ok(await PurchaseOrderSuggestionHelper.ComputeVendorOrderBuildAsync(nexusOperationsDb, vendorId, ct)));

    [HttpPost("order-suggestions/preview")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> PreviewOrderSuggestions([FromBody] OrderSuggestionPreviewRequest body, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<OrderSuggestionPreviewResult>>.Ok(await PurchaseOrderSuggestionHelper.PreviewAsync(nexusOperationsDb, body, ct)));

    [HttpPost("order-suggestions/accept")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> AcceptOrderSuggestion([FromBody] AcceptOrderSuggestionRequest body, CancellationToken ct) =>
        Ok(ApiResponse<AcceptOrderSuggestionResult>.Ok(await PurchaseOrderSuggestionHelper.AcceptAsync(nexusOperationsDb, body, ct)));

    [HttpPost("order-suggestions/accept-batch")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> AcceptOrderSuggestionBatch([FromBody] AcceptOrderSuggestionBatchRequest body, CancellationToken ct) =>
        Ok(ApiResponse<AcceptOrderSuggestionBatchResult>.Ok(await PurchaseOrderSuggestionHelper.AcceptBatchAsync(nexusOperationsDb, body, ct)));

    [HttpPost("order-suggestions/manual")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> AddManualOrder([FromBody] ManualOrderRequest body, CancellationToken ct) =>
        Ok(ApiResponse<ManualOrderResult>.Ok(await PurchaseOrderSuggestionHelper.ManualAsync(nexusOperationsDb, body, ct)));

    [HttpPost("order-suggestions/manual/bulk")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> AddManualOrdersBulk([FromBody] ManualOrderBulkRequest body, CancellationToken ct) =>
        Ok(ApiResponse<ManualOrderBulkResult>.Ok(await PurchaseOrderSuggestionHelper.ManualBulkAsync(nexusOperationsDb, body, ct)));

    [HttpGet("order-suggestions/tracked")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> ListTrackedOrders(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<OrderSuggestionTrackedRow>>.Ok(await PurchaseOrderSuggestionHelper.ListTrackedAsync(nexusOperationsDb, ct)));

    [HttpPost("order-suggestions/assign-schedule-agreement")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> AssignScheduleAgreement([FromBody] AssignScheduleAgreementRequest body, CancellationToken ct) =>
        Ok(ApiResponse<AssignScheduleAgreementResult>.Ok(await PurchaseOrderSuggestionHelper.AssignScheduleAgreementAsync(nexusOperationsDb, body, ct)));

    [HttpPut("order-suggestions/{suggestionId:long}")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> UpdateOrderSuggestion(long suggestionId, [FromBody] UpdateOrderSuggestionStatusRequest body, CancellationToken ct)
    {
        await PurchaseOrderSuggestionHelper.UpdateStatusAsync(nexusOperationsDb, suggestionId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPatch("order-suggestions/{suggestionId:long}/po-item")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> UpdateOrderSuggestionPoItem(long suggestionId, [FromBody] UpdateOrderSuggestionPoItemRequest body, CancellationToken ct)
    {
        await PurchaseOrderSuggestionHelper.UpdatePoItemAsync(nexusOperationsDb, suggestionId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("order-suggestions/{suggestionId:long}")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> DeleteOrderSuggestion(long suggestionId, CancellationToken ct)
    {
        await PurchaseOrderSuggestionHelper.DeleteAsync(nexusOperationsDb, suggestionId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    // ── Sub-phase 8b.4: Inbound shipment tracking (log.PurchaseOrderShipment) ──
    // Mark Received/Undo Received (real SAP goods-receipt write) are deferred to 8b.7.

    [HttpPatch("order-suggestions/{suggestionId:long}/shipment")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> AssignOrderShipment(long suggestionId, [FromBody] AssignOrderShipmentRequest body, CancellationToken ct)
    {
        await InboundShipmentHelper.AssignShipmentAsync(nexusOperationsDb, suggestionId, body.ShipmentId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpGet("order-suggestions/shipments")]
    [Authorize(Policy = "Perm:LOG_MRP,WAREHOUSE_OP")]
    public async Task<IActionResult> ListOrderShipments(CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<OrderShipmentListRow>>.Ok(await InboundShipmentHelper.ListShipmentsAsync(nexusOperationsDb, ct)));

    [HttpPost("order-suggestions/shipments")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> CreateOrderShipment([FromBody] CreateOrderShipmentRequest body, CancellationToken ct) =>
        Ok(ApiResponse<CreateOrderShipmentResult>.Ok(await InboundShipmentHelper.CreateShipmentAsync(nexusOperationsDb, logisticsOptions, body, ct)));

    [HttpPost("order-suggestions/shipments/manual")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> CreateManualOrderShipment([FromBody] CreateManualOrderShipmentRequest body, CancellationToken ct) =>
        Ok(ApiResponse<CreateManualOrderShipmentResult>.Ok(await InboundShipmentHelper.CreateManualShipmentAsync(nexusOperationsDb, logisticsOptions, body, ct)));

    [HttpGet("order-suggestions/shipments/{shipmentId:long}")]
    [Authorize(Policy = "Perm:LOG_MRP,WAREHOUSE_OP")]
    public async Task<IActionResult> GetOrderShipment(long shipmentId, CancellationToken ct)
    {
        var data = await InboundShipmentHelper.GetShipmentDetailAsync(nexusOperationsDb, shipmentId, ct);
        if (data is null) return NotFound(ApiResponse<object?>.Fail("NOT_FOUND", "Shipment not found."));
        return Ok(ApiResponse<OrderShipmentDetailResult>.Ok(data));
    }

    [HttpPut("order-suggestions/shipments/{shipmentId:long}")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> UpdateOrderShipment(long shipmentId, [FromBody] UpdateOrderShipmentRequest body, CancellationToken ct)
    {
        await InboundShipmentHelper.UpdateShipmentAsync(nexusOperationsDb, shipmentId, body, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpPost("order-suggestions/shipments/{shipmentId:long}/cancel")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> CancelOrderShipment(long shipmentId, CancellationToken ct) =>
        Ok(ApiResponse<CancelOrderShipmentResult>.Ok(await InboundShipmentHelper.CancelShipmentAsync(nexusOperationsDb, shipmentId, GetUsername(), ct)));

    [HttpGet("order-suggestions/shipments/{shipmentId:long}/manual-items")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> ListManualInboundItems(long shipmentId, CancellationToken ct) =>
        Ok(ApiResponse<IReadOnlyList<ManualInboundItemRow>>.Ok(await InboundShipmentHelper.ListManualItemsAsync(nexusOperationsDb, shipmentId, ct)));

    [HttpPost("order-suggestions/shipments/{shipmentId:long}/manual-items")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> AddManualInboundItem(long shipmentId, [FromBody] AddManualInboundItemRequest body, CancellationToken ct)
    {
        await InboundShipmentHelper.AddManualItemAsync(nexusOperationsDb, shipmentId, body, GetUsername(), ct);
        return StatusCode(201, ApiResponse<object?>.Ok(null));
    }

    [HttpDelete("order-suggestions/manual-items/{itemId:long}")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> RemoveManualInboundItem(long itemId, CancellationToken ct)
    {
        await InboundShipmentHelper.RemoveManualItemAsync(nexusOperationsDb, itemId, ct);
        return Ok(ApiResponse<object?>.Ok(null));
    }

    [HttpGet("order-suggestions/shipments/{shipmentId:long}/documents/folder")]
    [Authorize(Policy = "Perm:LOG_MRP,WAREHOUSE_OP")]
    public async Task<IActionResult> GetShipmentDocumentFolder(long shipmentId, CancellationToken ct) =>
        Ok(ApiResponse<InboundShipmentDocumentFolderResult>.Ok(await InboundShipmentHelper.GetDocumentFolderAsync(nexusOperationsDb, logisticsOptions, shipmentId, ct)));

    [HttpGet("order-suggestions/shipments/{shipmentId:long}/documents/{fileName}")]
    [Authorize(Policy = "Perm:LOG_MRP,WAREHOUSE_OP")]
    public async Task<IActionResult> GetShipmentDocument(long shipmentId, string fileName, CancellationToken ct)
    {
        var path = await InboundShipmentHelper.ResolveDocumentPathAsync(nexusOperationsDb, logisticsOptions, shipmentId, fileName, ct);
        var provider = new Microsoft.AspNetCore.StaticFiles.FileExtensionContentTypeProvider();
        if (!provider.TryGetContentType(path, out var contentType)) contentType = "application/octet-stream";
        return PhysicalFile(path, contentType, Path.GetFileName(path));
    }

    [HttpPost("order-suggestions/shipments/{shipmentId:long}/documents/upload")]
    [Authorize(Policy = "Perm:LOG_MRP")]
    public async Task<IActionResult> UploadShipmentDocument(long shipmentId, [FromQuery] string? fileName, CancellationToken ct)
    {
        using var buffer = new MemoryStream();
        await Request.Body.CopyToAsync(buffer, ct);
        var result = await InboundShipmentHelper.UploadDocumentAsync(nexusOperationsDb, logisticsOptions, shipmentId, buffer.ToArray(), fileName, ct);
        return StatusCode(201, ApiResponse<UploadedInboundDocumentResult>.Ok(result));
    }
}
