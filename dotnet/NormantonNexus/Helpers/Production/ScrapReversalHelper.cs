using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Production;

/// <summary>
/// Scrap Reversal — search + missed-reversals + reverse action, port of the
/// corresponding section of routes/productionnexus.js. Reverses
/// prod.ScrapMaterialDocuments via SapServer's MBST endpoint
/// (POST /api/production/scrap/reverse) — distinct from ReversalHelper
/// (SAP Reversals, reversing prod.SAPPostings/backflush documents via
/// MF41 instead), though both share the same Mf41Request DTO shape.
///
/// DEVIATION, deliberate — same as ReversalHelper.BulkReverseAsync: Node's
/// /scrap-reversal/reverse/bulk streams progress over SSE; this port's
/// BulkReverseAsync runs the same concurrent per-item SAP calls but
/// returns one plain JSON response. See ReversalHelper.cs's doc comment
/// for the full rationale — not repeated per-cluster.
///
/// CONTRACT NOTE confirmed by reading SapServer/Controllers/
/// ProductionController.cs's ReverseScrap action directly: POST
/// api/production/scrap/reverse always returns HTTP 200 with a single
/// BdcResponse (not an array/wrapper, and never a non-2xx failure for a
/// genuine ABAP-level rejection — only for a real transport/permission
/// failure) — the "always 200, caller reads Type" convention SapServer's
/// own CLAUDE.md documents for Backflush/PostScrap/ReverseBackflush
/// applies here too. Node's reverseScrapDocumentItem hedges defensively
/// against several possible response shapes (an array under
/// data.responses, M7/067 arriving via either a thrown HTTP error or a
/// 200 body) because its author evidently didn't have this confirmed —
/// this port only needs the single-BdcResponse-in-a-200 path plus a
/// generic catch for real connectivity/permission failures.
/// </summary>
internal static class ScrapReversalHelper
{
    // BackflushReversed is TRUE when EITHER the process table's own
    // IsReversed=1, OR prod.SAPPostings has a reversed backflush for this
    // job (more reliable for historical reversals done before the
    // process-table update existed) — mirrors Node's scrapDocSql exactly.
    private static string ScrapDocSql(string where) => $"""
        SELECT smd.ScrapDocumentID, smd.ScrapID, smd.MaterialDocument,
               smd.IsReversed, smd.ReversalDocument, smd.PostedAt,
               se.ProcessCode, se.ProcessRecordID,
               CAST(se.Quantity AS DECIMAL(12,3)) AS Quantity, se.UnitOfMeasure,
               sr.ReasonCode, sr.ReasonDescription,
               pu.Username AS PostedBy,
               prc.BatchRef, prc.Material,
               CASE WHEN ISNULL(prc.ProcRev, 0) = 1
                      OR EXISTS (
                           SELECT 1 FROM prod.SAPPostings sp2
                           WHERE  sp2.ProcessCode      = se.ProcessCode
                             AND  sp2.ProcessRecordID  = se.ProcessRecordID
                             AND  sp2.IsReversed       = 1
                             AND  sp2.MaterialDocumentSAP IS NOT NULL
                         )
                    THEN 1 ELSE 0 END AS BackflushReversed
        FROM   prod.ScrapMaterialDocuments smd
        JOIN   prod.ScrapEntries se ON se.ScrapID = smd.ScrapID
        LEFT JOIN prod.ScrapReasons sr ON sr.ReasonID = se.ReasonID
        LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = smd.PostedByUserID
        LEFT JOIN (
          SELECT N'MX' AS PC, MixingID    AS RID, MixRef    AS BatchRef, Material, IsReversed AS ProcRev FROM prod.Mixing
          UNION ALL SELECT N'EX', ExtrusionID,    ExtRef,   Material, IsReversed FROM prod.Extrusion
          UNION ALL SELECT N'CO', ConvolutingID,  ConvRef,  Material, IsReversed FROM prod.Convoluting
          UNION ALL SELECT N'BR', BraidingID,     BraidRef, Material, IsReversed FROM prod.Braiding
          UNION ALL SELECT N'CL', CoverlineID,    CovRef,   Material, IsReversed FROM prod.Coverline
          UNION ALL SELECT N'TW', TapeWrapID,     TWRef,    Material, IsReversed FROM prod.TapeWrap
          UNION ALL SELECT N'DR', DrummingID,     DrumRef,  Material, IsReversed FROM prod.Drumming
        ) prc ON prc.PC = se.ProcessCode AND prc.RID = se.ProcessRecordID
        WHERE  smd.MaterialDocument IS NOT NULL
          {where}
        ORDER BY smd.PostedAt DESC
        """;

    // ── GET /scrap-reversal/missed ───────────────────────────────────────────

    internal static async Task<IReadOnlyList<ScrapDocSearchRow>> GetMissedAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ScrapDocSearchRow>(new CommandDefinition(
            ScrapDocSql("""
                AND smd.IsReversed = 0
                AND (ISNULL(prc.ProcRev, 0) = 1
                     OR EXISTS (SELECT 1 FROM prod.SAPPostings sp2
                                WHERE sp2.ProcessCode = se.ProcessCode
                                  AND sp2.ProcessRecordID = se.ProcessRecordID
                                  AND sp2.IsReversed = 1
                                  AND sp2.MaterialDocumentSAP IS NOT NULL))
                """), cancellationToken: ct));
        return rows.AsList();
    }

    // ── GET /scrap-reversal/search ───────────────────────────────────────────

    internal static async Task<IReadOnlyList<ScrapDocSearchRow>> SearchAsync(INexusOperationsDb db, ScrapReversalSearchQuery query, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(query.MaterialDocument) && string.IsNullOrWhiteSpace(query.BatchRef)
            && string.IsNullOrWhiteSpace(query.Material) && string.IsNullOrWhiteSpace(query.ProcessCode)
            && string.IsNullOrWhiteSpace(query.DateFrom) && string.IsNullOrWhiteSpace(query.DateTo)
            && string.IsNullOrWhiteSpace(query.Operator))
        {
            throw new NexusValidationException("At least one search parameter is required.");
        }

        using var connection = await db.CreateConnectionAsync(ct);

        var conditions = new List<string>();
        var parameters = new DynamicParameters();

        if (!string.IsNullOrWhiteSpace(query.MaterialDocument))
        {
            parameters.Add("doc", $"%{query.MaterialDocument}%");
            conditions.Add("AND smd.MaterialDocument LIKE @doc");
        }
        if (!string.IsNullOrWhiteSpace(query.BatchRef))
        {
            parameters.Add("ref", $"%{query.BatchRef}%");
            conditions.Add("AND prc.BatchRef LIKE @ref");
        }
        if (!string.IsNullOrWhiteSpace(query.Material))
        {
            parameters.Add("mat", $"%{query.Material}%");
            conditions.Add("AND prc.Material LIKE @mat");
        }
        if (!string.IsNullOrWhiteSpace(query.ProcessCode))
        {
            parameters.Add("pc", query.ProcessCode.ToUpperInvariant());
            conditions.Add("AND se.ProcessCode = @pc");
        }
        if (!string.IsNullOrWhiteSpace(query.DateFrom))
        {
            parameters.Add("from", $"{query.DateFrom} 00:00:00");
            conditions.Add("AND smd.PostedAt >= CONVERT(datetime, @from, 120)");
        }
        if (!string.IsNullOrWhiteSpace(query.DateTo))
        {
            parameters.Add("to", $"{query.DateTo} 23:59:59");
            conditions.Add("AND smd.PostedAt <= CONVERT(datetime, @to, 120)");
        }
        if (!string.IsNullOrWhiteSpace(query.Operator))
        {
            parameters.Add("op", $"%{query.Operator}%");
            conditions.Add("AND pu.Username LIKE @op");
        }

        var rows = await connection.QueryAsync<ScrapDocSearchRow>(new CommandDefinition(
            ScrapDocSql(string.Join(" ", conditions)), parameters, cancellationToken: ct));
        return rows.AsList();
    }

    // ── POST /scrap-reversal/reverse ─────────────────────────────────────────

    internal static async Task<ScrapReversalReverseResult> ReverseAsync(
        INexusOperationsDb db, ISapServerClient sap, IAuditLogger audit,
        ScrapReversalReverseRequest body, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        var outcome = await ReverseScrapDocumentItemAsync(db, sap, audit, body.ScrapDocumentId, body.MaterialDocument, username, ipAddress, userId, ct);

        if (!outcome.Success)
        {
            throw outcome.Status switch
            {
                404 => new NexusNotFoundException(outcome.Error!),
                409 => new NexusConflictException(outcome.Error!),
                400 => new NexusValidationException(outcome.Error!),
                _ => new NexusBadGatewayException(outcome.Error!),
            };
        }

        return new ScrapReversalReverseResult(outcome.ReversalDocument, outcome.Synced);
    }

    // ── POST /scrap-reversal/reverse/bulk ────────────────────────────────────

    internal static async Task<IReadOnlyList<ScrapReversalBulkItemResult>> BulkReverseAsync(
        INexusOperationsDb db, ISapServerClient sap, IAuditLogger audit,
        ScrapReversalReverseRequest[] items, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        var tasks = items.Select(async item =>
        {
            var outcome = await ReverseScrapDocumentItemAsync(db, sap, audit, item.ScrapDocumentId, item.MaterialDocument, username, ipAddress, userId, ct);
            return new ScrapReversalBulkItemResult(item.ScrapDocumentId, item.MaterialDocument, outcome.Success, outcome.Error, outcome.ReversalDocument, outcome.Synced);
        });
        return await Task.WhenAll(tasks);
    }

    private readonly record struct ScrapReversalItemOutcome(bool Success, string? Error, string? ReversalDocument, bool Synced, int Status);

    /// <summary>
    /// Shared by ReverseAsync and BulkReverseAsync — never throws, matching
    /// Node's reverseScrapDocumentItem's own "never-throws" contract (bulk
    /// runs many of these concurrently and one item's failure must not
    /// cancel the others still in flight).
    /// </summary>
    private static async Task<ScrapReversalItemOutcome> ReverseScrapDocumentItemAsync(
        INexusOperationsDb db, ISapServerClient sap, IAuditLogger audit,
        int scrapDocumentId, string materialDocument, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        if (scrapDocumentId <= 0 || string.IsNullOrWhiteSpace(materialDocument))
            return new ScrapReversalItemOutcome(false, "scrapDocumentID and materialDocument are required.", null, false, 400);

        using var connection = await db.CreateConnectionAsync(ct);

        var isReversed = await connection.QuerySingleOrDefaultAsync<bool?>(new CommandDefinition(
            "SELECT IsReversed FROM prod.ScrapMaterialDocuments WHERE ScrapDocumentID = @scrapDocumentId",
            new { scrapDocumentId }, cancellationToken: ct));

        if (isReversed is null) return new ScrapReversalItemOutcome(false, "Scrap document not found.", null, false, 404);
        if (isReversed.Value) return new ScrapReversalItemOutcome(false, "Already reversed.", null, false, 409);

        async Task SyncDbAsync(string? reversalDoc)
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE prod.ScrapMaterialDocuments
                SET IsReversed = 1, ReversalDocument = @reversalDoc,
                    ReversedAt = GETDATE(), ReversedByUserID = @userId
                WHERE ScrapDocumentID = @scrapDocumentId
                """, new { reversalDoc, userId, scrapDocumentId }, cancellationToken: ct));
        }

        BdcResponse? response;
        try
        {
            response = await sap.PostAsync<BdcResponse>("api/production/scrap/reverse", new Mf41Request(materialDocument), userId, ct: ct);
        }
        catch (Exception sapErr)
        {
            var errMsg = sapErr.Message;
            await audit.LogAsync("SAP_ERROR", username, $"'{materialDocument}' SCRAP REVERSAL FAILED - Message = \"{errMsg}\"", ipAddress, ct);
            return new ScrapReversalItemOutcome(false, errMsg, null, false, 502);
        }

        if (response is null)
        {
            const string errMsg = "SAP returned no reversal response.";
            await audit.LogAsync("SAP_ERROR", username, $"'{materialDocument}' SCRAP REVERSAL FAILED - Message = \"{errMsg}\"", ipAddress, ct);
            return new ScrapReversalItemOutcome(false, errMsg, null, false, 502);
        }

        if (response.MessageClass == "M7" && response.MessageNumber == "067")
        {
            await SyncDbAsync(null);
            await audit.LogAsync("SAP_OK", username, $"'{materialDocument}' SCRAP ALREADY REVERSED IN SAP - synced", ipAddress, ct);
            return new ScrapReversalItemOutcome(true, null, null, true, 200);
        }

        // Node does not validate Type=="S" on this path either (unlike
        // scrap/post's parseBomScrapResponse) — matching that real,
        // unvalidated behavior exactly, not tightening it.
        await SyncDbAsync(response.DocumentNumber);
        await audit.LogAsync("SAP_OK", username, $"'{materialDocument}' SCRAP REVERSED - Reversal Document = '{response.DocumentNumber}'", ipAddress, ct);
        return new ScrapReversalItemOutcome(true, null, response.DocumentNumber, false, 200);
    }
}
