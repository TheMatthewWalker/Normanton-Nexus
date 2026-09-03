using Dapper;
using Microsoft.Data.SqlClient;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Production;

/// <summary>
/// Scrap approve/reject/retry/queue — port of the scrap-management section
/// of routes/productionnexus.js (summary, failed, entries, pending, retry,
/// approve, reject, documents). SAP posting goes through SapServer's
/// POST /api/production/scrap/post, which explodes the finished-good
/// material's BOM server-side and posts one MB11/BDC per component,
/// returning a BdcWrapper (one BdcResponse per component) — see
/// ProductionSapModels.cs.
/// </summary>
internal static class ScrapHelper
{
    private const string SapEndpointNotDeployedMessage =
        "SAP endpoint not found (404) — /api/production/scrap/post has not been deployed on the SapServer yet.";

    // COALESCE across every process table's own BatchRef/Material columns —
    // repeated verbatim across summary/failed/entries/pending, mirrors
    // Node's identical repeated COALESCE(...) join block exactly.
    private const string ProcessJoinSql = """
        LEFT JOIN prod.Mixing       mx ON mx.MixingID       = se.ProcessRecordID AND se.ProcessCode = 'MX'
        LEFT JOIN prod.Drumming     dr ON dr.DrummingID     = se.ProcessRecordID AND se.ProcessCode = 'DR'
        LEFT JOIN prod.Extrusion    ex ON ex.ExtrusionID    = se.ProcessRecordID AND se.ProcessCode = 'EX'
        LEFT JOIN prod.Convoluting  co ON co.ConvolutingID  = se.ProcessRecordID AND se.ProcessCode = 'CO'
        LEFT JOIN prod.Braiding     br ON br.BraidingID     = se.ProcessRecordID AND se.ProcessCode = 'BR'
        LEFT JOIN prod.Coverline    cl ON cl.CoverlineID    = se.ProcessRecordID AND se.ProcessCode = 'CL'
        LEFT JOIN prod.TapeWrap     tw ON tw.TapeWrapID     = se.ProcessRecordID AND se.ProcessCode = 'TW'
        LEFT JOIN prod.Ewald        ew ON ew.EwaldID        = se.ProcessRecordID AND se.ProcessCode = 'EW'
        LEFT JOIN prod.HoseAssembly ha ON ha.HoseAssemblyID = se.ProcessRecordID AND se.ProcessCode = 'HA'
        """;

    private const string BatchRefMaterialSql = """
        COALESCE(mx.MixRef, dr.DrumRef, ex.ExtRef, co.ConvRef,
                 br.BraidRef, cl.CovRef, tw.TWRef, ew.EwaldRef, ha.HARef) AS BatchRef,
        COALESCE(mx.Material, dr.Material, ex.Material, co.Material,
                 br.Material, cl.Material, tw.Material, ew.Material, ha.Material) AS Material
        """;

    // ── Scrap summary ────────────────────────────────────────────────────

    internal static async Task<IReadOnlyList<ScrapSummaryRow>> GetSummaryAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ScrapSummaryRow>(new CommandDefinition("""
            SELECT se.ProcessCode,
                   sr.ReasonCode, sr.ReasonDescription,
                   se.UnitOfMeasure,
                   COUNT(*)         AS EntryCount,
                   SUM(se.Quantity) AS TotalScrap
            FROM   prod.ScrapEntries se
            LEFT JOIN prod.ScrapReasons sr ON sr.ReasonID = se.ReasonID
            WHERE  se.SAPPosted = 1
              AND  EXISTS (
                     SELECT 1 FROM prod.ScrapMaterialDocuments smd
                     WHERE  smd.ScrapID = se.ScrapID AND smd.IsReversed = 0
                   )
            GROUP  BY se.ProcessCode, sr.ReasonCode, sr.ReasonDescription, se.UnitOfMeasure
            ORDER  BY se.ProcessCode, TotalScrap DESC
            """, cancellationToken: ct));
        return rows.AsList();
    }

    // ── Scrap — failed postings (approved but SAP rejected) ────────────────

    internal static async Task<IReadOnlyList<ScrapFailedRow>> GetFailedAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ScrapFailedRow>(new CommandDefinition($"""
            SELECT se.ScrapID, se.ProcessCode, se.ProcessRecordID,
                   se.ReasonID, sr.ReasonCode, sr.ReasonDescription,
                   se.Quantity, se.UnitOfMeasure, se.EnteredAt,
                   se.SAPErrorMessage, se.ApprovedAt,
                   pu.Username AS EnteredBy,
                   {BatchRefMaterialSql}
            FROM   prod.ScrapEntries se
            JOIN   prod.ScrapReasons sr ON sr.ReasonID = se.ReasonID
            LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = se.EnteredByUserID
            {ProcessJoinSql}
            WHERE  se.IsApproved = 1 AND se.SAPPosted = 0 AND se.IsVoided = 0
            ORDER BY se.ApprovedAt DESC
            """, cancellationToken: ct));
        return rows.AsList();
    }

    // ── Scrap — pending supervisor approval ─────────────────────────────────

    internal static async Task<IReadOnlyList<ScrapPendingRow>> GetPendingAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        // Column-existence guards: both IsApproved and IsVoided were added
        // out-of-band via migrations not managed by this app (see
        // dotnet/CLAUDE.md's "Schema stays as-is" principle) — if either is
        // absent on a given environment the filter is omitted so the page
        // still renders, matching Node's real defensive behavior exactly.
        var cols = (await connection.QueryAsync<string>(new CommandDefinition("""
            SELECT name FROM sys.columns
            WHERE object_id = OBJECT_ID(N'prod.ScrapEntries')
              AND name IN (N'IsApproved', N'IsVoided')
            """, cancellationToken: ct))).ToHashSet(StringComparer.OrdinalIgnoreCase);

        var approvedFilter = cols.Contains("IsApproved") ? "AND se.IsApproved = 0" : "";
        var voidedFilter = cols.Contains("IsVoided") ? "AND se.IsVoided = 0" : "";

        var rows = await connection.QueryAsync<ScrapPendingRow>(new CommandDefinition($"""
            SELECT se.ScrapID, se.ProcessCode, se.ProcessRecordID,
                   sr.ReasonCode, sr.ReasonDescription,
                   se.Quantity, se.UnitOfMeasure, se.EnteredAt, se.Notes,
                   pu.Username AS EnteredBy,
                   {BatchRefMaterialSql}
            FROM   prod.ScrapEntries se
            JOIN   prod.ScrapReasons sr ON sr.ReasonID = se.ReasonID
            LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = se.EnteredByUserID
            {ProcessJoinSql}
            WHERE  1=1 {approvedFilter} {voidedFilter}
            ORDER BY se.EnteredAt DESC
            """, cancellationToken: ct));
        return rows.AsList();
    }

    // ── Scrap entries (filterable) ──────────────────────────────────────────

    internal static async Task<IReadOnlyList<ScrapEntryRow>> GetEntriesAsync(
        INexusOperationsDb db, string? processCode, int? processRecordId, string? reasonCode, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var where = "";
        var parameters = new DynamicParameters();
        if (!string.IsNullOrWhiteSpace(processCode))
        {
            parameters.Add("pc", processCode.ToUpperInvariant());
            where += " AND se.ProcessCode = @pc";
        }
        if (processRecordId is not null)
        {
            parameters.Add("rid", processRecordId.Value);
            where += " AND se.ProcessRecordID = @rid";
        }
        if (!string.IsNullOrWhiteSpace(reasonCode))
        {
            parameters.Add("rc", reasonCode);
            where += " AND sr.ReasonCode = @rc";
        }

        var entries = (await connection.QueryAsync<(int ScrapId, string ProcessCode, int ProcessRecordId, string? ReasonCode, string? ReasonDescription,
                decimal Quantity, string UnitOfMeasure, DateTime EnteredAt, string? Notes, bool IsApproved, bool SapPosted,
                string? SapMaterialDocument, string? SapErrorMessage, bool IsReversed, string? EnteredBy, string? BatchRef, string? Material)>(
            new CommandDefinition($"""
                SELECT se.ScrapID, se.ProcessCode, se.ProcessRecordID,
                       sr.ReasonCode, sr.ReasonDescription,
                       se.Quantity, se.UnitOfMeasure, se.EnteredAt, se.Notes,
                       se.IsApproved, se.SAPPosted, se.SAPMaterialDocument, se.SAPErrorMessage,
                       se.IsReversed,
                       pu.Username AS EnteredBy,
                       {BatchRefMaterialSql}
                FROM   prod.ScrapEntries se
                LEFT JOIN prod.ScrapReasons sr ON sr.ReasonID = se.ReasonID
                LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = se.EnteredByUserID
                {ProcessJoinSql}
                WHERE  1=1 {where}
                ORDER BY se.EnteredAt DESC
                """, parameters, cancellationToken: ct))).AsList();

        if (entries.Count == 0) return [];

        var ids = entries.Select(e => e.ScrapId).ToArray();
        var docs = (await connection.QueryAsync<(int ScrapId, string? MaterialDocument, bool IsReversed, string? ReversalDocument)>(
            new CommandDefinition("""
                SELECT ScrapID, MaterialDocument, IsReversed, ReversalDocument
                FROM   prod.ScrapMaterialDocuments
                WHERE  ScrapID IN @ids
                ORDER  BY ScrapDocumentID
                """, new { ids }, cancellationToken: ct))).ToList();

        var docsByScrapId = docs.GroupBy(d => d.ScrapId)
            .ToDictionary(g => g.Key, g => (IReadOnlyList<ScrapDocumentRef>)g.Select(d => new ScrapDocumentRef(d.MaterialDocument, d.IsReversed, d.ReversalDocument)).ToList());

        return entries.Select(e => new ScrapEntryRow(
            e.ScrapId, e.ProcessCode, e.ProcessRecordId, e.ReasonCode, e.ReasonDescription,
            e.Quantity, e.UnitOfMeasure, e.EnteredAt, e.Notes,
            e.IsApproved, e.SapPosted, e.SapMaterialDocument, e.SapErrorMessage, e.IsReversed,
            e.EnteredBy, e.BatchRef, e.Material,
            docsByScrapId.TryGetValue(e.ScrapId, out var d) ? d : [])).ToList();
    }

    // ── Scrap — retry a failed posting (with optional field edits) ─────────

    internal static async Task<ScrapRetryResult> RetryAsync(
        INexusOperationsDb db, ISapServerClient sap, IAuditLogger audit,
        int scrapId, ScrapRetryRequest body, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        // Validation phase — a failure here (not found / unknown process /
        // process record missing) is a plain 404/400, not a SAP failure, so
        // it deliberately propagates straight out rather than going through
        // the SAP-failure catch below (mirrors Node's early `return` before
        // ever reaching its try/catch's SAP-error branch).
        if (body.Quantity is not null || body.ReasonId is not null)
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE prod.ScrapEntries SET
                  Quantity = COALESCE(@qty, Quantity),
                  ReasonID = COALESCE(@rid, ReasonID)
                WHERE ScrapID = @scrapId
                """, new { qty = body.Quantity, rid = body.ReasonId, scrapId }, cancellationToken: ct));
        }

        var scrap = await connection.QuerySingleOrDefaultAsync<(string ProcessCode, int ProcessRecordId, decimal Quantity, string UnitOfMeasure, string? ReasonCode)?>(
            new CommandDefinition("""
                SELECT se.ProcessCode, se.ProcessRecordID, se.Quantity, se.UnitOfMeasure, sr.ReasonCode
                FROM   prod.ScrapEntries se
                JOIN   prod.ScrapReasons sr ON sr.ReasonID = se.ReasonID
                WHERE  se.ScrapID = @scrapId AND se.IsApproved = 1 AND se.SAPPosted = 0 AND se.IsVoided = 0
                """, new { scrapId }, cancellationToken: ct));

        if (scrap is null)
            throw new NexusNotFoundException("Entry not found, already posted, or voided.");

        var (processCode, processRecordId, quantity, _, rawReasonCode) = scrap.Value;

        if (!ProductionSapHelpers.Process.TryGetValue(processCode, out var cfg))
            throw new NexusValidationException($"Unknown process code: {processCode}");

        var mat = await connection.QuerySingleOrDefaultAsync<(string Material, string? BatchRef)?>(new CommandDefinition(
            $"SELECT Material, {cfg.Ref} AS BatchRef FROM {cfg.Table} WHERE {cfg.Pk} = @processRecordId",
            new { processRecordId }, cancellationToken: ct));

        if (mat is null) throw new NexusNotFoundException("Process record not found.");

        var (material, batchRef) = mat.Value;
        var trimmedReason = rawReasonCode?.Trim();
        var scrapReason = trimmedReason?.Length == 4 ? trimmedReason : null;

        // SAP call + persist phase — any failure here is a real SAP/DB
        // failure, caught, audited, best-effort recorded on the entry, and
        // re-thrown as a 502. batchRef is always resolved by this point, so
        // (unlike Node's own retry route) there's no ReferenceError risk in
        // referencing it from the catch below.
        try
        {
            var sapResponse = await sap.PostAsync<BdcWrapper>("api/production/scrap/post",
                new ScrapPostRequest(material, quantity, batchRef ?? scrapId.ToString(), "551", scrapReason), userId, ct: ct)
                ?? throw new InvalidOperationException("SAP returned no posting responses");

            var responses = ParseBomScrapResponse(sapResponse);

            await InsertScrapDocumentsAsync(connection, scrapId, responses, userId, ct);

            await connection.ExecuteAsync(new CommandDefinition(
                "UPDATE prod.ScrapEntries SET SAPPosted=1, SAPErrorMessage=NULL WHERE ScrapID=@scrapId",
                new { scrapId }, cancellationToken: ct));

            var docList = string.Join(", ", responses.Select(r => r.DocumentNumber).Where(d => !string.IsNullOrEmpty(d)));
            await audit.LogAsync("SAP_OK", username, $"'{batchRef}' SCRAP POSTED - Material Documents = '{docList}'", ipAddress, ct);
            await ProductionEventLogHelper.WriteEventAsync(connection, processCode, processRecordId, "NOTE",
                $"Scrap retry succeeded — ScrapID {scrapId} — MatDocs: {docList}", 0, userId, ct);

            return new ScrapRetryResult(responses.Select(r => r.DocumentNumber).Where(d => !string.IsNullOrEmpty(d)).ToList());
        }
        catch (Exception ex)
        {
            var errMsg = ex is SapProxyException { StatusCode: 404 } ? SapEndpointNotDeployedMessage : ex.Message;
            await audit.LogAsync("SAP_ERROR", username, $"'{batchRef}' SCRAP FAILED - Message = \"{errMsg}\"", ipAddress, ct);
            try
            {
                await connection.ExecuteAsync(new CommandDefinition(
                    "UPDATE prod.ScrapEntries SET SAPErrorMessage=@errMsg WHERE ScrapID=@scrapId",
                    new { errMsg, scrapId }, cancellationToken: ct));
            }
            catch { /* best-effort, matches Node's .catch(() => {}) */ }
            throw new NexusBadGatewayException(errMsg);
        }
    }

    // ── Scrap — approve and post selected entries to SAP (bulk) ────────────

    internal static async Task<IReadOnlyList<ScrapBulkItemResult>> ApproveAsync(
        INexusOperationsDb db, ISapServerClient sap, IAuditLogger audit,
        int[] scrapIds, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        var tasks = scrapIds.Select(id => ApproveOneAsync(db, sap, audit, id, username, ipAddress, userId, ct));
        return await Task.WhenAll(tasks);
    }

    private static async Task<ScrapBulkItemResult> ApproveOneAsync(
        INexusOperationsDb db, ISapServerClient sap, IAuditLogger audit,
        int scrapId, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        try
        {
            var scrap = await connection.QuerySingleOrDefaultAsync<(string ProcessCode, int ProcessRecordId, decimal Quantity, string UnitOfMeasure, string? ReasonCode)?>(
                new CommandDefinition("""
                    SELECT se.ProcessCode, se.ProcessRecordID, se.Quantity, se.UnitOfMeasure, sr.ReasonCode
                    FROM   prod.ScrapEntries se
                    JOIN   prod.ScrapReasons sr ON sr.ReasonID = se.ReasonID
                    WHERE  se.ScrapID = @scrapId AND se.IsApproved = 0 AND se.IsVoided = 0
                    """, new { scrapId }, cancellationToken: ct));

            if (scrap is null) return new ScrapBulkItemResult(scrapId, false, "Not found, already approved, or voided.", null);

            var (processCode, processRecordId, quantity, _, rawReasonCode) = scrap.Value;

            if (!ProductionSapHelpers.Process.TryGetValue(processCode, out var cfg))
                return new ScrapBulkItemResult(scrapId, false, $"Unknown process: {processCode}", null);

            var mat = await connection.QuerySingleOrDefaultAsync<(string Material, string? BatchRef, bool IsReversed)?>(new CommandDefinition(
                $"SELECT Material, {cfg.Ref} AS BatchRef, IsReversed FROM {cfg.Table} WHERE {cfg.Pk} = @processRecordId",
                new { processRecordId }, cancellationToken: ct));

            if (mat is null) return new ScrapBulkItemResult(scrapId, false, "Process record not found.", null);

            var (material, batchRef, isReversed) = mat.Value;
            if (isReversed) return new ScrapBulkItemResult(scrapId, false, "Cannot approve — the parent backflush has been reversed.", null);

            var trimmedReason = rawReasonCode?.Trim();
            var scrapReason = trimmedReason?.Length == 4 ? trimmedReason : null;

            var sapResponse = await sap.PostAsync<BdcWrapper>("api/production/scrap/post",
                new ScrapPostRequest(material, quantity, batchRef ?? scrapId.ToString(), "551", scrapReason), userId, ct: ct)
                ?? throw new InvalidOperationException("SAP returned no posting responses");

            var responses = ParseBomScrapResponse(sapResponse);

            await InsertScrapDocumentsAsync(connection, scrapId, responses, userId, ct);

            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE prod.ScrapEntries
                SET IsApproved=1, ApprovedAt=GETDATE(), ApprovedByUserID=@userId,
                    SAPPosted=1, SAPErrorMessage=NULL
                WHERE ScrapID=@scrapId
                """, new { userId, scrapId }, cancellationToken: ct));

            var docNumbers = responses.Select(r => r.DocumentNumber).Where(d => !string.IsNullOrEmpty(d)).ToList();
            var docList = string.Join(", ", docNumbers);
            await audit.LogAsync("SAP_OK", username, $"'{scrapId}' SCRAP POSTED - Material Documents = '{docList}'", ipAddress, ct);
            await ProductionEventLogHelper.WriteEventAsync(connection, processCode, processRecordId, "NOTE",
                $"Scrap approved & posted — ScrapID {scrapId} — MatDocs: {docList}", 0, userId, ct);

            return new ScrapBulkItemResult(scrapId, true, null, docNumbers);
        }
        catch (Exception ex)
        {
            var is404 = ex is SapProxyException { StatusCode: 404 };
            var errMsg = is404 ? SapEndpointNotDeployedMessage : ex.Message;

            await audit.LogAsync("SAP_ERROR", username, $"'{scrapId}' SCRAP FAILED - Message = \"{errMsg}\"", ipAddress, ct);

            // Only mark as approved+failed when the SAP server was actually
            // reached. A 404 means the endpoint doesn't exist — leave the
            // entry as pending so it can be retried once SapServer is
            // updated, matching Node's real behavior exactly.
            if (!is404)
            {
                try
                {
                    await connection.ExecuteAsync(new CommandDefinition("""
                        UPDATE prod.ScrapEntries SET IsApproved=1, ApprovedAt=GETDATE(), ApprovedByUserID=@userId,
                        SAPPosted=0, SAPErrorMessage=@errMsg WHERE ScrapID=@scrapId
                        """, new { userId, scrapId, errMsg }, cancellationToken: ct));
                }
                catch { /* best-effort, matches Node's .catch(() => {}) */ }
            }

            return new ScrapBulkItemResult(scrapId, false, errMsg, null);
        }
    }

    // ── Scrap — reject selected pending entries (bulk) ──────────────────────

    internal static async Task<IReadOnlyList<ScrapBulkItemResult>> RejectAsync(
        INexusOperationsDb db, IAuditLogger audit, int[] scrapIds, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        var tasks = scrapIds.Select(id => RejectOneAsync(db, audit, id, username, ipAddress, userId, ct));
        return await Task.WhenAll(tasks);
    }

    private static async Task<ScrapBulkItemResult> RejectOneAsync(
        INexusOperationsDb db, IAuditLogger audit, int scrapId, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        try
        {
            var scrap = await connection.QuerySingleOrDefaultAsync<(string ProcessCode, int ProcessRecordId, decimal Quantity, string UnitOfMeasure, string? ReasonCode)?>(
                new CommandDefinition("""
                    SELECT se.ProcessCode, se.ProcessRecordID, se.Quantity, se.UnitOfMeasure, sr.ReasonCode
                    FROM   prod.ScrapEntries se
                    JOIN   prod.ScrapReasons sr ON sr.ReasonID = se.ReasonID
                    WHERE  se.ScrapID = @scrapId AND se.IsApproved = 0 AND se.IsVoided = 0 AND se.SAPPosted = 0
                    """, new { scrapId }, cancellationToken: ct));

            if (scrap is null) return new ScrapBulkItemResult(scrapId, false, "Not found, already approved, or voided.", null);

            var (processCode, processRecordId, quantity, uom, reasonCode) = scrap.Value;

            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE prod.ScrapEntries SET IsVoided = 1
                WHERE ScrapID = @scrapId AND IsApproved = 0 AND IsVoided = 0 AND SAPPosted = 0
                """, new { scrapId }, cancellationToken: ct));

            await audit.LogAsync("SCRAP_REJECT", username,
                $"ScrapID '{scrapId}' REJECTED - {quantity} {uom} reason {reasonCode}", ipAddress, ct);
            await ProductionEventLogHelper.WriteEventAsync(connection, processCode, processRecordId, "NOTE",
                $"Scrap rejected by supervisor — ScrapID {scrapId} ({quantity} {uom}, reason {reasonCode})", 0, userId, ct);

            return new ScrapBulkItemResult(scrapId, true, null, null);
        }
        catch (Exception ex)
        {
            return new ScrapBulkItemResult(scrapId, false, ex.Message, null);
        }
    }

    // ── GET /scrap-reasons ───────────────────────────────────────────────────

    internal static async Task<IReadOnlyList<ScrapReasonRow>> GetReasonsAsync(INexusOperationsDb db, string? processCode, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var pc = string.IsNullOrWhiteSpace(processCode) ? null : processCode.ToUpperInvariant();
        var rows = await connection.QueryAsync<ScrapReasonRow>(new CommandDefinition("""
            SELECT ReasonID, ReasonCode, ReasonDescription, AppliesTo
            FROM prod.ScrapReasons
            WHERE IsActive = 1
              AND (@pc IS NULL OR AppliesTo IS NULL OR AppliesTo = @pc
                   OR AppliesTo LIKE @pc + ',%'
                   OR AppliesTo LIKE '%,' + @pc + ',%'
                   OR AppliesTo LIKE '%,' + @pc)
            ORDER BY ReasonCode
            """, new { pc }, cancellationToken: ct));
        return rows.AsList();
    }

    // ── GET /scrap/:scrapId/documents ───────────────────────────────────────

    internal static async Task<IReadOnlyList<ScrapDocumentRow>> GetDocumentsAsync(INexusOperationsDb db, int scrapId, CancellationToken ct)
    {
        if (scrapId <= 0) throw new NexusValidationException("Invalid scrap ID.");

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ScrapDocumentRow>(new CommandDefinition("""
            SELECT ScrapDocumentID, MaterialDocument, SAPType, MessageClass, MessageNumber,
                   SAPMessage, PostedAt, PostedByUserID,
                   IsReversed, ReversalDocument, ReversedAt, ReversedByUserID
            FROM   prod.ScrapMaterialDocuments
            WHERE  ScrapID = @scrapId
            ORDER  BY ScrapDocumentID
            """, new { scrapId }, cancellationToken: ct));
        return rows.AsList();
    }

    // ── Shared SAP-response helpers ─────────────────────────────────────────

    /// <summary>
    /// Unwraps a BdcWrapper response from /api/production/scrap/post,
    /// validating every entry (type=S, messageClass=M7, messageNumber=060).
    /// Mirrors Node's parseBomScrapResponse exactly.
    /// </summary>
    private static List<BdcResponse> ParseBomScrapResponse(BdcWrapper sapResponse)
    {
        if (sapResponse.Responses is not { Count: > 0 } responses)
            throw new InvalidOperationException("SAP returned no posting responses");

        foreach (var r in responses)
        {
            if (r.Type != "S" || r.MessageClass != "M7" || r.MessageNumber != "060")
            {
                throw new InvalidOperationException(r.Message is { Length: > 0 } msg ? msg : $"SAP posting failed: {r.Type} {r.MessageClass} {r.MessageNumber}");
            }
        }
        return responses;
    }

    /// <summary>Inserts one ScrapMaterialDocuments row per BdcResponse. Mirrors Node's insertScrapDocuments exactly.</summary>
    private static async Task InsertScrapDocumentsAsync(SqlConnection connection, int scrapId, List<BdcResponse> responses, int userId, CancellationToken ct)
    {
        foreach (var r in responses)
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO prod.ScrapMaterialDocuments
                  (ScrapID, MaterialDocument, SAPType, MessageClass, MessageNumber, SAPMessage, PostedByUserID)
                VALUES (@scrapId, @doc, @type, @mc, @mn, @msg, @userId)
                """, new
            {
                scrapId,
                doc = r.DocumentNumber ?? "",
                type = r.Type ?? "",
                mc = r.MessageClass,
                mn = r.MessageNumber,
                msg = r.Message,
                userId
            }, cancellationToken: ct));
        }
    }
}
