using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Controllers;

/// <summary>
/// Purchasing/Performance — Logistics Sub-phase 8b.1 (read-only dashboard
/// routes only; vendor/demand-adjustment/Isopar/order-suggestion/SAP-write
/// routes are deferred to 8b.2 through 8b.7 — see dotnet/CLAUDE.md). Port of
/// the corresponding GET routes in routes/performance.js, mounted at
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
}
