using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Purchasing/Performance — Logistics Sub-phase 8b.1 (read-only dashboard
/// routes) + 8b.2 (vendor master data, demand adjustments, Isopar readings/
/// planning-rate/stock-risk). Order-suggestion engine/Inbound Costs/SAP-write
/// routes are deferred to 8b.3 through 8b.7 — see dotnet/CLAUDE.md. Port of
/// the corresponding routes in routes/performance.js, mounted at
/// api/performance matching Node's own mount. requireLogin-only at Node's
/// mount point maps to this base class's [Authorize]; every route below
/// additionally carries its own real Node permission gate.
/// </summary>
[Route("api/performance")]
public sealed class PerformanceController(INexusDb nexusDb, INexusOperationsDb nexusOperationsDb) : NexusControllerBase
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
}
