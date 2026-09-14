using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Warehouse;

/// <summary>
/// Port of routes/sap.js's POST /warehouse/batch-cleanup-transfer(-bulk) —
/// a LOG_SUPER-gated wrapper around the exact same transfer-order/
/// consignment-mb1b calls WarehouseStockHelper already exposes ungated
/// (used by Stock Management's own manual single/mass transfer panel).
/// Used ONLY by Stock Investigations' Batch Discrepancies tool (zero-sum
/// clean-up, single-batch/bulk consolidation, Move to Holding, pull-from-
/// holding for single-line negatives, and the Stock in Investigation
/// card's own "Create Transfer Order" action) — which moves stock across
/// many batches automatically rather than one row a person explicitly
/// picked, hence the stricter gate on this wrapper over the plain proxy.
///
/// The one real behavioral difference from the plain proxy, confirmed by
/// reading Node's executeBatchCleanupItem directly rather than assumed: a
/// successful transfer also runs RedrumReversalHelper's re-drum check
/// (Node's own maybeReverseBatchManagedReturn call) — best-effort, a
/// lookup/reversal failure must never undo the transfer that already
/// succeeded in SAP. RedrumReversalHelper itself already no-ops for any
/// destination other than SA/PTFE, so this is safe to call unconditionally
/// on every successful transfer, matching Node's own unconditional call.
/// </summary>
internal static class WarehouseBatchCleanupHelper
{
    internal static async Task<BatchCleanupItemResult> ExecuteAsync(
        INexusOperationsDb db, ISapServerClient sap, IAuditLogger audit,
        BatchCleanupItem item, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        if (item.Kind != "transfer" && item.Kind != "consignment")
        {
            return new BatchCleanupItemResult(false, "kind must be 'transfer' or 'consignment'", null);
        }

        try
        {
            if (item.Kind == "consignment")
            {
                if (item.Consignment is null) return new BatchCleanupItemResult(false, "consignment payload required", null);
                var consignResult = await WarehouseStockHelper.CreateConsignmentMb1bAsync(db, sap, userId, item.Consignment, ct);
                var parts = new[] { consignResult.Mb1bMessage, consignResult.ToNonConsignMessage, consignResult.ToConsignMessage }
                    .Where(s => !string.IsNullOrEmpty(s)).ToList();
                return new BatchCleanupItemResult(true, parts.Count > 0 ? string.Join("; ", parts) : "Consignment processed", null);
            }

            if (item.Transfer is null) return new BatchCleanupItemResult(false, "transfer payload required", null);

            var transferResult = await WarehouseStockHelper.CreateTransferOrderAsync(db, sap, userId, item.Transfer, ct);
            if (!transferResult.Success)
            {
                var message = transferResult.Messages.Count > 0
                    ? string.Join("; ", transferResult.Messages.Select(m => m.Message))
                    : "SAP rejected the transfer order.";
                return new BatchCleanupItemResult(false, message, null);
            }

            try
            {
                using var connection = await db.CreateConnectionAsync(ct);
                await RedrumReversalHelper.MaybeReverseBatchManagedReturnAsync(
                    connection, sap, audit, item.Transfer.Batch, item.Transfer.DestinationType, item.Transfer.DestinationBin,
                    item.Transfer.StorageLocation, username, ipAddress, userId, ct);
            }
            catch
            {
                // Never let a redrum lookup/reversal failure undo a transfer that
                // already succeeded in SAP — matches RedrumReversalHelper's own
                // "every failure path degrades to a Warning" design (it shouldn't
                // throw at all, but this stays defensive regardless).
            }

            return new BatchCleanupItemResult(true, transferResult.TransferOrderNumber is { Length: > 0 } tr ? $"TO {tr}" : "Done", transferResult.TransferOrderNumber);
        }
        catch (Exception ex)
        {
            return new BatchCleanupItemResult(false, ex.Message, null);
        }
    }

    /// <summary>Same per-item try/catch + Task.WhenAll concurrency as WarehouseStockHelper.CreateTransferOrdersBulkAsync — ExecuteAsync itself already never throws, but this still guards each item independently so a genuinely unexpected exception in one never cancels the rest.</summary>
    internal static async Task<IReadOnlyList<BatchCleanupItemResult>> ExecuteBulkAsync(
        INexusOperationsDb db, ISapServerClient sap, IAuditLogger audit,
        IReadOnlyList<BatchCleanupItem> items, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        var tasks = items.Select(async item =>
        {
            try
            {
                return await ExecuteAsync(db, sap, audit, item, username, ipAddress, userId, ct);
            }
            catch (Exception ex)
            {
                return new BatchCleanupItemResult(false, ex.Message, null);
            }
        });
        return await Task.WhenAll(tasks);
    }
}
