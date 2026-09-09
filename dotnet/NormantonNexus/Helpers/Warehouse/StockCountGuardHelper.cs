using Dapper;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Warehouse;

/// <summary>
/// Thrown by StockCountGuardHelper.AssertTransfersAllowedAsync — mirrors
/// lib/stockCountGuard.js's plain `TransferBlockedError extends Error`
/// exactly: a bare exception carrying no HTTP status of its own, since
/// Node's own callers decide the response code from whichever try/catch
/// happens to wrap the call (Staging Post's deliver route folds this into
/// the same generic 422 "SAP rejected..." bucket as a real SAP rejection —
/// see StagingHelper.DeliverAsync). Deliberately NOT a NexusApiException:
/// baking in one fixed status code here would be wrong for every caller.
/// </summary>
internal sealed class TransferBlockedException(string message) : Exception(message);

/// <summary>
/// Blocks transfer-order/TR creation for a storage location while a Raw
/// Material, Production, or Finished Goods stock count is active against
/// that location — a stock movement mid-count would invalidate the count's
/// quantity comparison. Port of lib/stockCountGuard.js. Deliberately scoped
/// per storage location (not a global lock) and deliberately excludes
/// PTFE_WEEKLY (small enough not to warrant blocking warehouse operations).
/// Finished Goods Count's own mass-move/manual-TO discrepancy-resolution
/// actions (StockCountHelper) call SapServer directly, bypassing this guard
/// entirely, since they exist specifically to resolve findings from the
/// very count that would otherwise block them — that exemption was already
/// correct in this port's existing Finance/StockCount work (it never called
/// this guard to begin with), so nothing changes there.
/// </summary>
internal static class StockCountGuardHelper
{
    /// <summary>Throws TransferBlockedException if an active (Open/PendingApproval/Approved), non-PTFE_WEEKLY count exists for storageLocation. Silently no-ops (does not block) when storageLocation is missing — callers that can't determine a storage location for a given request skip the check rather than failing closed.</summary>
    internal static async Task AssertTransfersAllowedAsync(INexusOperationsDb db, string? storageLocation, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(storageLocation)) return;

        using var connection = await db.CreateConnectionAsync(ct);
        var active = await connection.QuerySingleOrDefaultAsync<(int CountId, string CountType, string Status)?>(new CommandDefinition("""
            SELECT TOP 1 CountId, CountType, Status
            FROM log.StockCountDocument
            WHERE StorageLocation = @storageLocation
              AND CountType <> 'PTFE_WEEKLY'
              AND Status IN ('Open', 'PendingApproval', 'Approved')
            ORDER BY CreatedAtUtc DESC
            """, new { storageLocation }, cancellationToken: ct));

        if (active is not null)
        {
            throw new TransferBlockedException(
                $"Transfers are blocked for storage location {storageLocation} while {active.Value.CountType} count #{active.Value.CountId} is active (status: {active.Value.Status}).");
        }
    }
}
