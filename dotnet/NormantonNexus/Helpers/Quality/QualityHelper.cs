using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Quality;

/// <summary>
/// Quality department logic — port of routes/quality.js (Stock Information)
/// and the concession-review slice of routes/productionnexus.js (Traceability
/// Concessions, reused by Quality's UI — see ReviewConcessionAsync's own
/// comments for what's deliberately NOT ported yet).
/// </summary>
internal static class QualityHelper
{
    // Per-tile codes replacing the Node app's two coarser codes. Block/Unblock
    // split matches the two separate tiles Node already has; QUAL_BLOCKING
    // covered both directions (plus both directions of Bulk) with one code —
    // see the migration for the default group that reproduces that.
    internal const string FnBlockStock = "QUAL_BLOCK_STOCK";
    internal const string FnUnblockStock = "QUAL_UNBLOCK_STOCK";
    internal const string FnTraceabilityConcession = "QUAL_TRACEABILITY_CONCESSION";

    private static readonly string[] LquaColumns = ["LGORT", "LGTYP", "LGPLA", "MATNR", "VERME", "CHARG", "BESTQ", "SOBKZ", "SONUM"];

    // WM-managed storage locations — only these need Bin Type/Bin on the
    // block/unblock form (SapServer's QualityController runs an extra
    // transfer-order leg for these; Normanton-Nexus never needs to know that
    // detail itself, just which fields to require on the form).
    internal static readonly string[] WmManagedStorageLocations = ["1710", "1711"];

    // Node's quality.js signs every one of its SapServer calls with a FIXED
    // {userId: 0} service identity (jwt.sign inline in that file's own
    // makeSapToken(), no argument) — confirmed distinct from
    // routes/packaging.js, which passes the real calling user's id. Preserved
    // exactly rather than "corrected" to the real user, since whatever
    // SapDepartmentPermissions provisioning exists on the SapServer side for
    // these RFCs may already be keyed to that fixed identity.
    private const int SapServiceUserId = 0;

    /// <summary>
    /// Display Stock — deliberately NOT SapServer's QualityController.GetBlockedStock
    /// (BESTQ EQ 'S', blocked-only). The real Node frontend never calls that
    /// endpoint; it builds its own unfiltered ZRFC_READ_TABLES call for ALL
    /// stock in warehouse 312 and colors blocked rows client-side. That's
    /// confirmed live behavior (not dead-code parity for its own sake), so
    /// it's what this ports — see the migration plan's research notes.
    /// </summary>
    internal static async Task<IReadOnlyList<StockRow>> DisplayStockAsync(ISapServerClient sap, CancellationToken ct)
    {
        var request = new RfcExecuteRequest(
            FunctionName: "ZRFC_READ_TABLES",
            ImportParameters: new Dictionary<string, object?> { ["DELIMITER"] = "|", ["ROWCOUNT"] = "9999", ["NO_DATA"] = " " },
            InputTables: new Dictionary<string, List<Dictionary<string, object?>>>
            {
                ["QUERY_TABLES"] = [new Dictionary<string, object?> { ["TABNAME"] = "LQUA" }],
            },
            InputTablesItems: new Dictionary<string, List<Dictionary<string, object?>>>
            {
                ["query_FIELDS"] = LquaColumns
                    .Select(f => new Dictionary<string, object?> { ["TABNAME"] = "LQUA", ["FIELDNAME"] = f })
                    .ToList(),
                ["where_clause"] = [new Dictionary<string, object?> { ["TEXT"] = "LQUA~LGNUM EQ 312" }],
            },
            ExportParameters: [],
            OutputTables: new Dictionary<string, List<string>> { ["data_display"] = ["WA"] });

        var response = await sap.PostAsync<RfcExecuteResponse>("api/rfc/execute", request, SapServiceUserId, ct: ct);

        if (response is null || !response.Tables.TryGetValue("data_display", out var rawRows))
        {
            return [];
        }

        // First row is a header row (skip it, matches Node's .slice(1)); each
        // remaining row's WA field is pipe-delimited, positionally mapped to
        // LquaColumns' order. Rows without a Material are dropped.
        var rows = new List<StockRow>();
        foreach (var rawRow in rawRows.Skip(1))
        {
            if (!rawRow.TryGetValue("WA", out var wa) || wa is null) continue;
            var fields = wa.Split('|').Select(f => f.Trim()).ToArray();
            if (fields.Length < 9 || string.IsNullOrWhiteSpace(fields[3])) continue;

            rows.Add(new StockRow(
                StorageLocation: fields[0], StorageType: fields[1], Bin: fields[2], Material: fields[3],
                AvailableQty: fields[4], Batch: fields[5], StockCategory: fields[6],
                SpecialStockInd: fields[7], SpecialStockNum: fields[8]));
        }

        return rows;
    }

    internal static async Task<QualityMb1bResponse> BlockOrUnblockAsync(
        ISapServerClient sap, IAuditLogger audit, string direction, BlockUnblockRequest body,
        string? username, string? ipAddress, CancellationToken ct)
    {
        var isWm = WmManagedStorageLocations.Contains(body.StorageLocation.Trim());
        var sapRequest = new QualityMb1bRequest(
            Material: body.Material,
            Quantity: body.Quantity,
            Header: body.Header,
            SpecialStockIndicator: body.SpecialStockIndicator ?? "",
            Batch: body.Batch ?? "",
            StorageLocation: body.StorageLocation,
            BinType: isWm ? body.BinType ?? "" : "",
            Bin: isWm ? body.Bin ?? "" : "",
            Username: username ?? "");

        try
        {
            var result = await sap.PostAsync<QualityMb1bResponse>($"api/quality/{direction}", sapRequest, SapServiceUserId, ct: ct);
            if (result is null)
            {
                // SapServer's controller always populates a real body on a
                // success envelope in practice — this only guards the type system.
                throw new SapProxyException(StatusCodes.Status502BadGateway, "SAP_EMPTY_RESPONSE", "SapServer returned an empty success response.");
            }
            await audit.LogAsync("SAP_OK", username, QualityAuditDetail(direction, body, result), ipAddress, ct);
            return result;
        }
        catch (SapProxyException ex)
        {
            await audit.LogAsync("SAP_ERROR", username, $"Quality {direction} failed for material {body.Material} - {ex.Message}", ipAddress, ct);
            throw;
        }
    }

    private static string QualityAuditDetail(string direction, BlockUnblockRequest body, QualityMb1bResponse result)
    {
        var parts = new[] { $"Material {body.Material}", body.Batch is { Length: > 0 } b ? $"Batch {b}" : null, result.Mb1bMessage, result.ToBlockedMessage, result.ToNonBlockedMessage }
            .Where(p => !string.IsNullOrWhiteSpace(p));
        return $"Quality {direction} succeeded - {string.Join(" | ", parts)}";
    }

    /// <summary>
    /// Runs one bulk row through the same block/unblock proxy call, converting
    /// a SAP-formatted quantity string ("10.875,000" -> 10875, European
    /// grouping) the same way routes/quality.js's bulk loop does. No audit
    /// call per row — matches Node's current behavior (bulk rows are NOT
    /// individually written to PortalAuditLog, only single block/unblock is).
    /// </summary>
    internal static async Task<BulkProgressEvent> RunBulkRowAsync(
        ISapServerClient sap, string direction, BulkStockRow row, string header, string? username, CancellationToken ct)
    {
        var isWm = WmManagedStorageLocations.Contains(row.StorageLocation.Trim());
        var quantity = ParseSapQuantity(row.Quantity);

        var sapRequest = new QualityMb1bRequest(
            Material: row.Material.Trim(),
            Quantity: quantity == 0 ? 1 : quantity,
            Header: header,
            SpecialStockIndicator: row.SpecialStockIndicator ?? "",
            Batch: row.Batch ?? "",
            StorageLocation: row.StorageLocation,
            BinType: isWm ? row.StorageType ?? "" : "",
            Bin: isWm ? row.StorageBin ?? "" : "",
            Username: username ?? "");

        try
        {
            var result = await sap.PostAsync<QualityMb1bResponse>($"api/quality/{direction}", sapRequest, SapServiceUserId, ct: ct);
            var message = result?.Mb1bMessage is { Length: > 0 } m ? m
                : result?.ToBlockedMessage is { Length: > 0 } tb ? tb
                : result?.ToNonBlockedMessage is { Length: > 0 } tn ? tn
                : "Posted";
            return new BulkProgressEvent("progress", Success: true, Material: sapRequest.Material, Message: message);
        }
        catch (SapProxyException ex)
        {
            return new BulkProgressEvent("progress", Success: false, Material: sapRequest.Material, Error: ex.Message);
        }
    }

    /// <summary>European-grouped SAP quantity string ("10.875,000") -&gt; decimal. A lone-comma or plain-integer string parses the same way GetDecimal/ParseSapDecimal does on the SapServer side (see that repo's CLAUDE.md decimal-parsing history) — kept simple here since this is always a client-supplied already-validated numeric display string, not raw untrusted RFC text.</summary>
    private static decimal ParseSapQuantity(string raw)
    {
        raw = raw.Trim();
        if (raw.Length == 0) return 0;
        var normalized = raw.Contains(',') ? raw.Replace(".", "").Replace(',', '.') : raw.Replace(".", "");
        return decimal.TryParse(normalized, System.Globalization.CultureInfo.InvariantCulture, out var value) ? value : 0;
    }

    internal static async Task<IReadOnlyList<ConcessionRow>> ListConcessionsAsync(INexusOperationsDb db, string status, CancellationToken ct)
    {
        const string sql = """
            SELECT c.ConcessionID AS ConcessionId, c.ProcessCode, c.RecordID AS RecordId,
                   c.ParentProcessCode, c.ParentRecordID AS ParentRecordId, c.Component, c.ActualMaterial,
                   c.Reason, pu.Username AS RaisedByUsername, c.RaisedAt, c.Status,
                   ru.Username AS ReviewedByUsername, c.ReviewedAt, c.ReviewNotes
            FROM prod.TraceabilityConcessions c
            LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = c.RaisedByUserID
            LEFT JOIN Nexus.dbo.PortalUsers ru ON ru.UserID = c.ReviewedByUserID
            WHERE c.Status = @status
            ORDER BY c.RaisedAt DESC
            """;

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ConcessionRow>(new CommandDefinition(sql, new { status }, cancellationToken: ct));
        return rows.ToArray();
    }

    /// <summary>
    /// Approve/reject a concession. Deliberately does NOT (yet) write the
    /// production-batch event-log entry (writeEvent in Node) or send the
    /// raiser an in-app notification (notify() in Node) — both depend on
    /// systems not built yet in this migration (Production's own event log,
    /// and the Notifications feature deferred in Phase 1's CLAUDE.md notes).
    /// The core review action (status/reviewer/notes) is fully functional;
    /// come back and wire those two side effects in once their systems exist.
    /// </summary>
    internal static async Task<ConcessionRow> ReviewConcessionAsync(
        INexusOperationsDb db, int concessionId, string newStatus, string? notes, int reviewerUserId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var currentStatus = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "SELECT Status FROM prod.TraceabilityConcessions WHERE ConcessionID = @concessionId",
            new { concessionId }, cancellationToken: ct));

        if (currentStatus is null)
        {
            throw new NexusNotFoundException($"Concession {concessionId} not found.");
        }
        if (currentStatus != "PENDING")
        {
            throw new NexusValidationException($"This concession is already {currentStatus}.");
        }

        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE prod.TraceabilityConcessions
            SET Status = @newStatus, ReviewedByUserID = @reviewerUserId, ReviewedAt = GETDATE(), ReviewNotes = @notes
            WHERE ConcessionID = @concessionId
            """, new { newStatus, reviewerUserId, notes, concessionId }, cancellationToken: ct));

        var updated = await ListConcessionsAsync(db, newStatus, ct);
        return updated.First(c => c.ConcessionId == concessionId);
    }
}
