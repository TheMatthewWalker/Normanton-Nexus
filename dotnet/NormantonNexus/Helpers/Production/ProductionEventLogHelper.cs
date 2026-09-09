using Dapper;
using Microsoft.Data.SqlClient;

namespace NormantonNexus.Helpers.Production;

/// <summary>
/// prod.EventLog — the single most-used piece of cross-cutting
/// infrastructure in Production (60+ call sites in Node's
/// routes/productionnexus.js: every entry/complete/retry/cancel/scrap/
/// reversal/concession/staging action writes at least one row). Port of
/// the module-level writeEvent() helper. Takes an already-open connection
/// (not INexusOperationsDb) since every real call site writes this as one
/// of several statements against a connection it's already using within
/// one request — matches Node's own single-pool-reused-per-request shape,
/// including the lack of an explicit SQL transaction around the whole
/// request (a partial failure mid-sequence leaving earlier writes
/// committed is Node's real, intentional behavior — see e.g. Mixing
/// entry's per-tub loop, where some tubs can succeed while others fail).
/// </summary>
internal static class ProductionEventLogHelper
{
    internal static async Task WriteEventAsync(SqlConnection connection, string processCode, int recordId, string eventType, string message, int severity, int userId, CancellationToken ct)
    {
        await connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO prod.EventLog (ProcessCode, ProcessRecordID, EventType, EventMessage, Severity, CreatedByUserID)
            VALUES (@processCode, @recordId, @eventType, @message, @severity, @userId)
            """, new { processCode, recordId, eventType, message, severity, userId }, cancellationToken: ct));
    }
}
