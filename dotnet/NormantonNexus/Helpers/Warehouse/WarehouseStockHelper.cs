using NormantonNexus.Helpers.StockCount;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Warehouse;

/// <summary>
/// Stock Management / Transfer Orders / Transfer Requirements (LT04) —
/// Phase 10 frontend catch-up. Node's routes/sap.js proxies these straight
/// through to SapServer's own WarehouseController (thin: forward, unwrap,
/// audit-log) — this is the C# port of that same proxy layer, never built
/// during Phase 7 (see this file's own flagged gap in dotnet/CLAUDE.md).
/// Every request/response DTO mirrors SapServer's Models/Bapi/WarehouseModels.cs
/// field-for-field, confirmed by reading that source directly.
///
/// Permission gates match Node's own routes/sap.js exactly, not a guess:
/// stock/open-transfer-requirements/bin-storage-types/tr-cleanup-candidates
/// (reads) and transfer-order/create-lt04 (creates) carry NO requirePermission
/// call in Node — just requireLogin, i.e. any authenticated Warehouse dept
/// member — so this port gates them Dept:warehouse only. stock-adjustment
/// and delete-tr are requirePermission('LOG_SUPER') in Node, ported as-is.
/// </summary>
internal static class WarehouseStockHelper
{
    internal static async Task<IReadOnlyList<WarehouseStockRow>> GetStockAsync(ISapServerClient sap, int userId, StockQuery query, CancellationToken ct) =>
        await sap.GetAsync<List<WarehouseStockRow>>("api/warehouse/stock", userId, query, ct: ct) ?? [];

    internal static async Task<IReadOnlyList<OpenTransferRequirementRow>> GetOpenTransferRequirementsAsync(ISapServerClient sap, int userId, OpenTransferRequirementsQuery query, CancellationToken ct) =>
        await sap.GetAsync<List<OpenTransferRequirementRow>>("api/warehouse/open-transfer-requirements", userId, query, ct: ct) ?? [];

    internal static async Task<IReadOnlyList<string>> GetBinStorageTypesAsync(ISapServerClient sap, int userId, string bin, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(bin)) return [];
        return await sap.GetAsync<List<string>>("api/warehouse/bin-storage-types", userId, new { bin }, ct: ct) ?? [];
    }

    internal static async Task<IReadOnlyList<TrCleanupCandidateRow>> GetTrCleanupCandidatesAsync(ISapServerClient sap, int userId, CancellationToken ct) =>
        await sap.GetAsync<List<TrCleanupCandidateRow>>("api/warehouse/tr-cleanup-candidates", userId, ct: ct) ?? [];

    /// <summary>Port of Node's assertTransfersAllowed(params.StorageLocation) guard on POST /warehouse/transfer-order.</summary>
    internal static async Task<CreateTransferOrderResponse> CreateTransferOrderAsync(INexusOperationsDb db, ISapServerClient sap, int userId, CreateTransferOrderRequest body, CancellationToken ct)
    {
        await StockCountHelper.AssertTransfersAllowedAsync(db, body.StorageLocation, ct);
        return await sap.PostAsync<CreateTransferOrderResponse>("api/warehouse/transfer-order", body, userId, longRunning: true, ct: ct)
            ?? throw new NexusBadGatewayException("SapServer returned an empty transfer-order response.");
    }

    /// <summary>
    /// Bulk variant — Node's transfer-order-bulk fires every item concurrently
    /// (Promise.all over independently try/caught promises), not sequentially,
    /// and one item's failure never aborts the rest. Ported the same way via
    /// Task.WhenAll over per-item try/catch, matching the exact same "each
    /// target notified independently" resilience pattern already established
    /// elsewhere in this codebase (e.g. StagingHelper's notification fan-out).
    /// </summary>
    internal static async Task<IReadOnlyList<BulkItemResult<CreateTransferOrderResponse>>> CreateTransferOrdersBulkAsync(INexusOperationsDb db, ISapServerClient sap, int userId, IReadOnlyList<CreateTransferOrderRequest> items, CancellationToken ct)
    {
        var tasks = items.Select(async item =>
        {
            try
            {
                var result = await CreateTransferOrderAsync(db, sap, userId, item, ct);
                return new BulkItemResult<CreateTransferOrderResponse>(true, result, null);
            }
            catch (Exception ex)
            {
                return new BulkItemResult<CreateTransferOrderResponse>(false, null, ex.Message);
            }
        });
        return await Task.WhenAll(tasks);
    }

    /// <summary>Port of Node's assertTransfersAllowed(StorageLocation) guard on POST /warehouse/create-lt04 — StorageLocation is guard-only, never forwarded to SapServer (see CreateLt04Request's own comment).</summary>
    internal static async Task<BdcResponse> CreateLt04Async(INexusOperationsDb db, ISapServerClient sap, int userId, CreateLt04Request body, CancellationToken ct)
    {
        await StockCountHelper.AssertTransfersAllowedAsync(db, body.StorageLocation, ct);
        return await sap.PostAsync<BdcResponse>("api/warehouse/create-lt04", body, userId, longRunning: true, ct: ct)
            ?? throw new NexusBadGatewayException("SapServer returned an empty create-lt04 response.");
    }

    internal static async Task<IReadOnlyList<BulkItemResult<BdcResponse>>> CreateLt04BulkAsync(INexusOperationsDb db, ISapServerClient sap, int userId, IReadOnlyList<CreateLt04Request> items, CancellationToken ct)
    {
        var tasks = items.Select(async item =>
        {
            try
            {
                var result = await CreateLt04Async(db, sap, userId, item, ct);
                return new BulkItemResult<BdcResponse>(true, result, null);
            }
            catch (Exception ex)
            {
                return new BulkItemResult<BdcResponse>(false, null, ex.Message);
            }
        });
        return await Task.WhenAll(tasks);
    }

    /// <summary>LOG_SUPER-gated in Node — deleting a TR is unrecoverable, matching every other LOG_SUPER-tier destructive Warehouse action already in this app. No transfer guard in Node — deleting a TR doesn't move stock, so it's exempt.</summary>
    internal static async Task<BdcResponse> DeleteTrAsync(ISapServerClient sap, int userId, DeleteTrRequest body, CancellationToken ct) =>
        await sap.PostAsync<BdcResponse>("api/warehouse/delete-tr", body, userId, longRunning: true, ct: ct)
            ?? throw new NexusBadGatewayException("SapServer returned an empty delete-tr response.");

    /// <summary>
    /// LOG_SUPER-gated in Node, same as DeleteTrAsync. No transfer guard —
    /// confirmed by reading routes/sap.js's executeStockAdjustmentItem
    /// directly: unlike transfer-order/create-lt04, stock-adjustment is
    /// deliberately exempt, since it's the very tool used to write off/correct
    /// discrepancies a count itself found (Stock Investigations) — blocking
    /// it while that count is active would be self-defeating. Reuses the
    /// existing StockCountModels.StockAdjustmentRequest/Response DTOs
    /// (already proven by StockCountHelper.ApproveAsync's own 711/712
    /// postings) rather than duplicating a second copy.
    /// </summary>
    internal static async Task<StockAdjustmentResponse> CreateStockAdjustmentAsync(ISapServerClient sap, int userId, StockAdjustmentRequest body, CancellationToken ct) =>
        await sap.PostAsync<StockAdjustmentResponse>("api/warehouse/stock-adjustment", body, userId, ct: ct)
            ?? throw new NexusBadGatewayException("SapServer returned an empty stock-adjustment response.");
}
