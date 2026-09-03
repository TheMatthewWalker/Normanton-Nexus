using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Production;

/// <summary>
/// SAP Reversals — port of the Reversal section of routes/productionnexus.js
/// (search/by-batch/find/execute/mark/bulk). Reverses prod.SAPPostings/
/// backflush documents themselves — distinct from Scrap Reversal (a later
/// Sub-phase 6b slice built on prod.ScrapMaterialDocuments), though
/// ScrapHelper.ReverseJobScrapAsync (scrap cleanup cascading from a
/// backflush reversal) is shared infrastructure this cluster calls into.
///
/// DEVIATION, deliberate: Node's /reversal/bulk streams progress over
/// Server-Sent Events (one SSE connection per bulk request, with a 20s
/// heartbeat to survive proxy idle timeouts) since SapServer calls for a
/// large batch can take minutes combined. This port's BulkReverseAsync
/// runs the same per-document concurrent SAP calls (Task.WhenAll, same
/// "partial success is real" precedent as Scrap approve/reject) but
/// returns one plain JSON response instead of streaming progress — no SSE
/// infrastructure exists anywhere else in this port, and building it for
/// this one endpoint would be new infrastructure, not a port. The
/// functional outcome (which documents reversed, which failed, why) is
/// identical; only the UX of watching it happen live is not reproduced.
/// </summary>
internal static class ReversalHelper
{
    // ── GET /reversal/search ────────────────────────────────────────────────

    internal static async Task<IReadOnlyList<SapPostingRow>> SearchAsync(INexusOperationsDb db, string? materialDocument, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(materialDocument))
            throw new NexusValidationException("materialDocument is required.");

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<SapPostingRow>(new CommandDefinition("""
            SELECT SAPPostingID, ProcessCode, ProcessRecordID, PostingType, Quantity, UnitOfMeasure,
                   MaterialDocumentSAP, PostedAt, IsReversed
            FROM   prod.SAPPostings WHERE MaterialDocumentSAP = @materialDocument
            """, new { materialDocument }, cancellationToken: ct));
        return rows.AsList();
    }

    // ── GET /reversal/by-batch/:processCode/:recordId ───────────────────────

    internal static async Task<IReadOnlyList<SapPostingByBatchRow>> GetByBatchAsync(INexusOperationsDb db, string processCode, int recordId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<SapPostingByBatchRow>(new CommandDefinition("""
            SELECT sp.SAPPostingID, sp.PostingType, sp.MaterialDocumentSAP,
                   sp.Quantity, sp.UnitOfMeasure, sp.IsReversed,
                   sp.ReversalDocumentSAP, sp.PostedAt, sp.ReversedAt,
                   pu.Username AS PostedBy
            FROM   prod.SAPPostings sp
            LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = sp.PostedByUserID
            WHERE  sp.ProcessCode = @pc AND sp.ProcessRecordID = @recordId
              AND  sp.IsSuccess = 1 AND sp.MaterialDocumentSAP IS NOT NULL
            ORDER BY sp.PostedAt DESC
            """, new { pc = processCode.ToUpperInvariant(), recordId }, cancellationToken: ct));
        return rows.AsList();
    }

    // ── GET /reversal/find ───────────────────────────────────────────────────

    internal static async Task<IReadOnlyList<SapPostingFindRow>> FindAsync(INexusOperationsDb db, ReversalFindQuery query, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(query.Material) && string.IsNullOrWhiteSpace(query.DateFrom)
            && string.IsNullOrWhiteSpace(query.DateTo) && string.IsNullOrWhiteSpace(query.Operator))
        {
            throw new NexusValidationException("At least one search parameter is required.");
        }

        using var connection = await db.CreateConnectionAsync(ct);

        var materialParam = string.IsNullOrWhiteSpace(query.Material) ? null : $"%{query.Material}%";
        var operatorParam = string.IsNullOrWhiteSpace(query.Operator) ? null : $"%{query.Operator}%";
        var dateFromParam = string.IsNullOrWhiteSpace(query.DateFrom) ? null : $"{query.DateFrom} 00:00:00";
        var dateToParam = string.IsNullOrWhiteSpace(query.DateTo) ? null : $"{query.DateTo} 23:59:59";

        var rows = await connection.QueryAsync<SapPostingFindRow>(new CommandDefinition("""
            SELECT sp.SAPPostingID, sp.ProcessCode, sp.ProcessRecordID,
                   sp.PostingType, sp.Quantity, sp.UnitOfMeasure,
                   sp.MaterialDocumentSAP, sp.PostedAt, sp.IsReversed,
                   sp.ReversalDocumentSAP, sp.ReversedAt,
                   pu.Username AS PostedBy,
                   mat.Material
            FROM   prod.SAPPostings sp
            LEFT JOIN (
              SELECT N'MX' AS PC, MixingID       AS RID, Material FROM prod.Mixing
              UNION ALL SELECT N'EX', ExtrusionID,    Material FROM prod.Extrusion
              UNION ALL SELECT N'CO', ConvolutingID,  Material FROM prod.Convoluting
              UNION ALL SELECT N'BR', BraidingID,     Material FROM prod.Braiding
              UNION ALL SELECT N'CL', CoverlineID,    Material FROM prod.Coverline
              UNION ALL SELECT N'TW', TapeWrapID,     Material FROM prod.TapeWrap
              UNION ALL SELECT N'DR', DrummingID,     Material FROM prod.Drumming
            ) mat ON mat.PC = sp.ProcessCode AND mat.RID = sp.ProcessRecordID
            LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = sp.PostedByUserID
            WHERE  sp.IsSuccess = 1 AND sp.MaterialDocumentSAP IS NOT NULL
              AND  (@materialParam IS NULL OR mat.Material LIKE @materialParam)
              AND  (@dateFromParam IS NULL OR sp.PostedAt >= CONVERT(datetime, @dateFromParam, 120))
              AND  (@dateToParam   IS NULL OR sp.PostedAt <= CONVERT(datetime, @dateToParam,   120))
              AND  (@operatorParam IS NULL OR pu.Username  LIKE @operatorParam)
            ORDER BY sp.PostedAt DESC
            """, new { materialParam, dateFromParam, dateToParam, operatorParam }, cancellationToken: ct));
        return rows.AsList();
    }

    // ── PATCH /reversal/:sapPostingId ────────────────────────────────────────

    internal static async Task MarkReversedAsync(INexusOperationsDb db, ISapServerClient sap, int sapPostingId, ReversalMarkRequest body, int userId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.ReversalDocumentSap))
            throw new NexusValidationException("reversalDocumentSAP is required.");

        using var connection = await db.CreateConnectionAsync(ct);

        var post = await connection.QuerySingleOrDefaultAsync<(string ProcessCode, int ProcessRecordId)?>(new CommandDefinition(
            "SELECT ProcessCode, ProcessRecordID FROM prod.SAPPostings WHERE SAPPostingID=@sapPostingId",
            new { sapPostingId }, cancellationToken: ct));

        if (post is null) throw new NexusNotFoundException("SAP posting not found.");
        var (processCode, processRecordId) = post.Value;

        await connection.ExecuteAsync(new CommandDefinition(
            "UPDATE prod.SAPPostings SET IsReversed=1, ReversalDocumentSAP=@doc, ReversedAt=GETDATE(), ReversedByUserID=@userId WHERE SAPPostingID=@sapPostingId",
            new { doc = body.ReversalDocumentSap, userId, sapPostingId }, cancellationToken: ct));

        if (ProductionSapHelpers.Process.TryGetValue(processCode, out var cfg))
        {
            await connection.ExecuteAsync(new CommandDefinition(
                $"UPDATE {cfg.Table} SET IsReversed=1, ReversedAt=GETDATE(), ReversedByUserID=@userId WHERE {cfg.Pk}=@processRecordId",
                new { userId, processRecordId }, cancellationToken: ct));
        }

        await ScrapHelper.ReverseJobScrapAsync(connection, sap, processCode, processRecordId, userId, ct);

        await ProductionEventLogHelper.WriteEventAsync(connection, processCode, processRecordId, "REVERSAL",
            $"SAP posting {sapPostingId} reversed — reversal doc: {body.ReversalDocumentSap}", 1, userId, ct);
    }

    // ── POST /reversal/execute ───────────────────────────────────────────────

    internal static async Task<ReversalExecuteResult> ExecuteAsync(ISapServerClient sap, IAuditLogger audit, string materialDocument, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(materialDocument))
            throw new NexusValidationException("materialDocument is required.");

        try
        {
            var response = await sap.PostAsync<BdcResponse>("api/production/reverse-backflush", new Mf41Request(materialDocument), userId, ct: ct)
                ?? throw new InvalidOperationException("SAP server error");

            if (response.Type == "S" && response.MessageClass == "RM" && response.MessageNumber == "196")
            {
                await audit.LogAsync("SAP_OK", username, $"'{materialDocument}' REVERSED - Reversal Document = '{response.DocumentNumber}'", ipAddress, ct);
                return new ReversalExecuteResult(response.DocumentNumber, materialDocument);
            }

            if (response.Type == "E")
            {
                if (response.MessageClass == "RM" && response.MessageNumber == "210")
                {
                    await audit.LogAsync("SAP_ERROR", username, $"'{materialDocument}' REVERSAL FAILED - Message = \"Already reversed\"", ipAddress, ct);
                    throw new NexusConflictException("This document has already been reversed — no further action needed.");
                }
                if (response.MessageClass == "M7" && response.MessageNumber == "066")
                {
                    await audit.LogAsync("SAP_ERROR", username, $"'{materialDocument}' REVERSAL FAILED - Message = \"Must use MBST\"", ipAddress, ct);
                    throw new NexusUnprocessableEntityException("This document needs to be reversed using MBST.");
                }
                var eMsg = response.Message is { Length: > 0 } m ? m : $"SAP error: {response.MessageClass} {response.MessageNumber}";
                await audit.LogAsync("SAP_ERROR", username, $"'{materialDocument}' REVERSAL FAILED - Message = \"{eMsg}\"", ipAddress, ct);
                throw new NexusBadGatewayException(eMsg);
            }

            var unexpectedMsg = response.Message is { Length: > 0 } um ? um : $"Unexpected SAP response: {response.Type} {response.MessageClass} {response.MessageNumber}";
            await audit.LogAsync("SAP_ERROR", username, $"'{materialDocument}' REVERSAL FAILED - Message = \"{unexpectedMsg}\"", ipAddress, ct);
            throw new NexusBadGatewayException(unexpectedMsg);
        }
        catch (Exception ex) when (ex is not NexusApiException)
        {
            var errMsg = ex.Message;
            await audit.LogAsync("SAP_ERROR", username, $"'{materialDocument}' REVERSAL FAILED - Message = \"{errMsg}\"", ipAddress, ct);
            throw new NexusBadGatewayException(errMsg);
        }
    }

    // ── POST /reversal/bulk ───────────────────────────────────────────────────

    internal static async Task<IReadOnlyList<ReversalBulkItemResult>> BulkReverseAsync(
        INexusOperationsDb db, ISapServerClient sap, IAuditLogger audit,
        string[] materialDocuments, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        var tasks = materialDocuments.Select(matDoc => BulkReverseOneAsync(db, sap, audit, matDoc, username, ipAddress, userId, ct));
        return await Task.WhenAll(tasks);
    }

    private static async Task<ReversalBulkItemResult> BulkReverseOneAsync(
        INexusOperationsDb db, ISapServerClient sap, IAuditLogger audit,
        string matDoc, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        try
        {
            var response = await sap.PostAsync<BdcResponse>("api/production/reverse-backflush", new Mf41Request(matDoc), userId, ct: ct)
                ?? throw new InvalidOperationException("SAP server error");

            if (response.Type == "S" && response.MessageClass == "RM" && response.MessageNumber == "196")
            {
                await MarkReversedByDocumentAsync(db, sap, matDoc, response.DocumentNumber, userId, ct);
                await audit.LogAsync("SAP_OK", username, $"'{matDoc}' REVERSED - Reversal Document = '{response.DocumentNumber}'", ipAddress, ct);
                return new ReversalBulkItemResult(matDoc, true, null, response.DocumentNumber, false);
            }

            if (response.Type == "E" && response.MessageClass == "RM" && response.MessageNumber == "210")
            {
                await MarkReversedByDocumentAsync(db, sap, matDoc, null, userId, ct);
                await audit.LogAsync("SAP_ERROR", username, $"'{matDoc}' REVERSAL FAILED - Message = \"Already reversed — synced\"", ipAddress, ct);
                return new ReversalBulkItemResult(matDoc, false, "Already reversed in SAP — record updated.", null, true);
            }

            if (response.Type == "E" && response.MessageClass == "M7" && response.MessageNumber == "066")
            {
                await audit.LogAsync("SAP_ERROR", username, $"'{matDoc}' REVERSAL FAILED - Message = \"Must use MBST\"", ipAddress, ct);
                return new ReversalBulkItemResult(matDoc, false, "Must be reversed using MBST.", null, false);
            }

            var rejMsg = response.Message is { Length: > 0 } m ? m : $"SAP rejected: {response.Type} {response.MessageClass} {response.MessageNumber}";
            await audit.LogAsync("SAP_ERROR", username, $"'{matDoc}' REVERSAL FAILED - Message = \"{rejMsg}\"", ipAddress, ct);
            return new ReversalBulkItemResult(matDoc, false, rejMsg, null, false);
        }
        catch (Exception ex)
        {
            var errMsg = ex.Message;
            await audit.LogAsync("SAP_ERROR", username, $"'{matDoc}' REVERSAL FAILED - Message = \"{errMsg}\"", ipAddress, ct);
            return new ReversalBulkItemResult(matDoc, false, errMsg, null, false);
        }
    }

    /// <summary>Mirrors Node's markReversed(matDoc, reversalDoc) — finds the posting by material document, marks it + its process record reversed, and cascades into ScrapHelper.ReverseJobScrapAsync.</summary>
    private static async Task MarkReversedByDocumentAsync(INexusOperationsDb db, ISapServerClient sap, string matDoc, string? reversalDoc, int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var post = await connection.QuerySingleOrDefaultAsync<(string ProcessCode, int ProcessRecordId)?>(new CommandDefinition(
            "SELECT TOP 1 ProcessCode, ProcessRecordID FROM prod.SAPPostings WHERE MaterialDocumentSAP=@matDoc AND IsSuccess=1",
            new { matDoc }, cancellationToken: ct));

        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE prod.SAPPostings SET IsReversed=1, ReversalDocumentSAP=@reversalDoc,
            ReversedAt=GETDATE(), ReversedByUserID=@userId
            WHERE MaterialDocumentSAP=@matDoc AND IsSuccess=1
            """, new { matDoc, reversalDoc, userId }, cancellationToken: ct));

        if (post is null) return;

        var (processCode, processRecordId) = post.Value;
        if (ProductionSapHelpers.Process.TryGetValue(processCode, out var cfg))
        {
            await connection.ExecuteAsync(new CommandDefinition(
                $"UPDATE {cfg.Table} SET IsReversed=1 WHERE {cfg.Pk}=@processRecordId",
                new { processRecordId }, cancellationToken: ct));
        }

        await ScrapHelper.ReverseJobScrapAsync(connection, sap, processCode, processRecordId, userId, ct);
    }
}
