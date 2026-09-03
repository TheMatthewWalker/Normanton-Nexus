using Dapper;
using Microsoft.Data.SqlClient;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Production;

/// <summary>
/// Failed Backflush — port of routes/productionnexus.js's
/// GET /failed-backflush, PATCH /failed-backflush/:pc/:id/retry and
/// PATCH /failed-backflush/:pc/:id/cancel. See FailedBackflushModels.cs's
/// header comment for the shape of this slice; this was the last piece of
/// "real, tracked, unbuilt scope" the BOM-infrastructure slice called out
/// — unblocked once Drumming's own entry flow (DrummingHelper) landed,
/// since the DR retry branch re-invokes almost all of that same logic.
/// </summary>
internal static class FailedBackflushHelper
{
    /// <summary>Every process with a Status=6 (SAP_FAILED) queue — mirrors Node's own UNION ALL exactly, including FW's deliberate absence (no retry branch exists for it either — see RetryAsync's default case).</summary>
    private static readonly string[] QueuedProcesses = ["MX", "EX", "CO", "BR", "CL", "TW", "DR", "EW", "HA"];

    internal static async Task<IReadOnlyList<FailedBackflushRow>> GetQueueAsync(INexusOperationsDb db, CancellationToken ct)
    {
        var unionParts = QueuedProcesses.Select(code =>
        {
            var (table, pk, refCol, uom, qtyCol) = ProductionSapHelpers.Process[code];
            var qtyExpr = uom == "M" ? qtyCol : $"CAST({qtyCol} AS DECIMAL(12,3))";
            return $"SELECT N'{code}' AS ProcessCode, {pk} AS RecordID, {refCol} AS BatchRef, Material, {qtyExpr} AS Quantity, N'{uom}' AS UOM, CreatedAt FROM {table} WHERE Status = 6";
        });

        var sql = $"""
            SELECT ab.ProcessCode, ab.RecordID AS RecordId, ab.BatchRef, ab.Material, ab.Quantity, ab.UOM AS Uom, ab.CreatedAt,
                   sp.ErrorMessage, sp.PostedAt AS FailedAt, sp.SAPPostingID AS SapPostingId
            FROM (
                {string.Join("\n                UNION ALL ", unionParts)}
            ) AS ab
            CROSS APPLY (
                SELECT TOP 1 ErrorMessage, PostedAt, SAPPostingID
                FROM prod.SAPPostings
                WHERE ProcessCode = ab.ProcessCode AND ProcessRecordID = ab.RecordID AND IsSuccess = 0
                ORDER BY PostedAt DESC
            ) sp
            ORDER BY ab.CreatedAt DESC
            """;

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<FailedBackflushRow>(new CommandDefinition(sql, cancellationToken: ct));
        return rows.ToArray();
    }

    /// <summary>PATCH /failed-backflush/:pc/:id/retry — dispatches to one of 5 real retry shapes (MX/DR/metre/EW/HA) plus a "not yet implemented" default (FW/unknown). Only MX handles its own SAP failures internally (per tub); everything else shares one catch that resets Status=6 and maps to a real HTTP 502 — mirrors Node's own single try/catch wrapping every branch but MX's per-tub loop exactly.</summary>
    internal static async Task<FailedBackflushRetryResult> RetryAsync(
        string processCode, int recordId, INexusOperationsDb db, ISapServerClient sap, IAuditLogger audit,
        FailedBackflushRetryRequest body, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        var code = processCode.ToUpperInvariant();
        using var connection = await db.CreateConnectionAsync(ct);

        try
        {
            return code switch
            {
                "MX" => await RetryMixingAsync(connection, sap, audit, recordId, body, username, ipAddress, userId, ct),
                "DR" => await RetryDrummingAsync(connection, sap, audit, recordId, body, username, ipAddress, userId, ct),
                _ when ProductionSapHelpers.MetreProcesses.Contains(code) =>
                    await RetryMetreProcessAsync(connection, sap, audit, code, recordId, body, username, ipAddress, userId, ct),
                "EW" => await RetryMarkCompleteAsync(connection, "EW", "EwaldID", "prod.Ewald", recordId, body.Material, body.Notes, userId, ct),
                "HA" => await RetryHoseAssemblyAsync(connection, recordId, body, userId, ct),
                _ => throw new NexusValidationException($"Retry not yet implemented for process {code}."),
            };
        }
        catch (Exception sapErr) when (sapErr is not NexusApiException)
        {
            var errMsg = sapErr.Message;
            await audit.LogAsync("SAP_ERROR", username, $"'{code}{recordId:D8}' FAILED - Message = \"{errMsg}\"", ipAddress, ct);

            if (ProductionSapHelpers.Process.TryGetValue(code, out var cfg))
            {
                await connection.ExecuteAsync(new CommandDefinition($"UPDATE {cfg.Table} SET Status = 6 WHERE {cfg.Pk} = @recordId", new { recordId }, cancellationToken: ct));
            }

            await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "SAP_FAIL", $"Retry failed: {errMsg}", 2, userId, ct);
            throw new NexusBadGatewayException(errMsg);
        }
    }

    /// <summary>MX — retries every individually-failed tub (prod.MixingTubs.SAPSuccess=0), never the whole mix at once. Each tub's own SAP failure is caught right here and recorded per-tub, so one bad tub never stops the rest from retrying. Mirrors Node exactly, including applying corrections and flipping Status=4 before checking whether there's anything left to retry at all.</summary>
    private static async Task<FailedBackflushRetryResult> RetryMixingAsync(
        SqlConnection connection, ISapServerClient sap, IAuditLogger audit, int recordId,
        FailedBackflushRetryRequest body, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE prod.Mixing SET
                MixCode = COALESCE(@mixCode, MixCode), Material = COALESCE(@mixCode, Material),
                SupplierBatchNo = COALESCE(@supplierBatchNo, SupplierBatchNo),
                SupplierTubNo = COALESCE(@supplierTubNo, SupplierTubNo),
                Notes = COALESCE(@notes, Notes), Status = 4
            WHERE MixingID = @recordId
            """, new { mixCode = body.MixCode, supplierBatchNo = body.SupplierBatchNo, supplierTubNo = body.SupplierTubNo, notes = body.Notes, recordId }, cancellationToken: ct));

        var current = await connection.QuerySingleOrDefaultAsync<(string MixCode, string? SupplierBatchNo)?>(new CommandDefinition(
            "SELECT MixCode, SupplierBatchNo FROM prod.Mixing WHERE MixingID = @recordId", new { recordId }, cancellationToken: ct));
        if (current is null) throw new NexusNotFoundException("Record not found.");

        var failedTubs = (await connection.QueryAsync<(int TubId, int TubSeq, decimal TubWeightKg)>(new CommandDefinition(
            "SELECT TubID AS TubId, TubSeq, TubWeightKG AS TubWeightKg FROM prod.MixingTubs WHERE MixingID = @recordId AND SAPSuccess = 0 ORDER BY TubSeq",
            new { recordId }, cancellationToken: ct))).ToList();

        if (failedTubs.Count == 0) throw new NexusValidationException("No failed tubs found for this mixing record.");

        await ProductionEventLogHelper.WriteEventAsync(connection, "MX", recordId, "NOTE", $"Retry by supervisor {userId} — {failedTubs.Count} tub(s) pending", 0, userId, ct);

        var mixRef = $"MX-{recordId:D8}";
        var results = new List<MxTubRetryResult>();
        var anyFailed = false;

        foreach (var tub in failedTubs)
        {
            try
            {
                var sapResponse = await sap.PostAsync<BdcResponse>("api/production/backflush",
                    new Zf40nRequest(current.Value.MixCode, tub.TubWeightKg, mixRef, "", current.Value.SupplierBatchNo ?? "", ""), userId, ct: ct)
                    ?? throw new InvalidOperationException("SapServer returned no backflush result.");
                var sapMatDoc = ProductionSapHelpers.ParseSapBackflush(sapResponse);
                await audit.LogAsync("SAP_OK", username, $"'{mixRef}' BACKFLUSHED - Material Document = '{sapMatDoc}'", ipAddress, ct);

                if (sapResponse.MessageNumber == "190")
                {
                    await ProductionSapHelpers.LogBackflushAlertAsync(connection, "MX", recordId, mixRef, sapMatDoc, sapResponse.MessageNumber, sapResponse.Message, ct);
                    await ProductionEventLogHelper.WriteEventAsync(connection, "MX", recordId, "NOTE",
                        $"SAP 190 tub {tub.TubSeq} retry: No component consumption — MatDoc: {sapMatDoc}. Flagged for data review.", 1, userId, ct);
                }

                await connection.ExecuteAsync(new CommandDefinition(
                    "UPDATE prod.MixingTubs SET MaterialDocumentSAP = @sapMatDoc, SAPSuccess = 1, SAPErrorMessage = NULL WHERE TubID = @tubId",
                    new { sapMatDoc, tubId = tub.TubId }, cancellationToken: ct));

                await connection.ExecuteAsync(new CommandDefinition("""
                    INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,MaterialDocumentSAP,IsSuccess,PostedByUserID)
                    VALUES ('MX',@recordId,'BACKFLUSH',@qty,'KG',@sapMatDoc,1,@userId)
                    """, new { recordId, qty = tub.TubWeightKg, sapMatDoc, userId }, cancellationToken: ct));

                await ProductionEventLogHelper.WriteEventAsync(connection, "MX", recordId, "SAP_POST",
                    $"Tub {tub.TubSeq} retry succeeded — MatDoc: {sapMatDoc}{(sapResponse.MessageNumber == "190" ? " (190: no components consumed)" : "")}", 0, userId, ct);

                results.Add(new MxTubRetryResult(tub.TubId, true, sapMatDoc, null));
            }
            catch (Exception err)
            {
                anyFailed = true;
                var errMsg = err.Message;
                await audit.LogAsync("SAP_ERROR", username, $"'{mixRef}' FAILED - Message = \"{errMsg}\"", ipAddress, ct);
                await connection.ExecuteAsync(new CommandDefinition(
                    "UPDATE prod.MixingTubs SET SAPErrorMessage = @errMsg WHERE TubID = @tubId", new { errMsg, tubId = tub.TubId }, cancellationToken: ct));
                await ProductionEventLogHelper.WriteEventAsync(connection, "MX", recordId, "SAP_FAIL", $"Tub {tub.TubSeq} retry failed: {errMsg}", 2, userId, ct);
                results.Add(new MxTubRetryResult(tub.TubId, false, null, errMsg));
            }
        }

        if (anyFailed)
        {
            await connection.ExecuteAsync(new CommandDefinition("UPDATE prod.Mixing SET Status = 6 WHERE MixingID = @recordId", new { recordId }, cancellationToken: ct));
            return new FailedBackflushRetryResult("SAP_FAILED", null, false, "Some tubs still failed.", results);
        }

        return new FailedBackflushRetryResult("COMPLETE", null, false, null, results);
    }

    /// <summary>DR — re-checks the same BOM-vs-traceability hard block submitDrumming itself uses (a drum lands in this queue either because that check BLOCKED it, or because a real SAP posting failed), then re-posts via the concession goods-movement path or the combined drumming-backflush endpoint, same as the original submission.</summary>
    private static async Task<FailedBackflushRetryResult> RetryDrummingAsync(
        SqlConnection connection, ISapServerClient sap, IAuditLogger audit, int recordId,
        FailedBackflushRetryRequest body, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE prod.Drumming SET
                Material = COALESCE(@material, Material),
                LengthMetres = COALESCE(@lengthMetres, LengthMetres),
                PackagingType = COALESCE(@packagingId, PackagingType),
                WeightKG = COALESCE(@weightKg, WeightKG),
                CustomerID = COALESCE(@customerNumber, CustomerID),
                SalesOrderSAP = COALESCE(@orderNumber, SalesOrderSAP),
                Notes = COALESCE(@comments, Notes)
            WHERE DrummingID = @recordId
            """, new
        {
            material = body.Material,
            lengthMetres = body.LengthMetres,
            packagingId = body.PackagingId,
            weightKg = body.WeightKg,
            customerNumber = body.CustomerNumber,
            orderNumber = body.OrderNumber,
            comments = body.Comments,
            recordId
        }, cancellationToken: ct));

        var current = await connection.QuerySingleOrDefaultAsync<(string DrumRef, string Material, decimal LengthMetres, decimal? WeightKg, string? PackagingType, string? CustomerId, string EntryType)?>(
            new CommandDefinition("""
                SELECT DrumRef, Material, LengthMetres, WeightKG AS WeightKg, PackagingType, CustomerID AS CustomerId, EntryType
                FROM prod.Drumming WHERE DrummingID = @recordId
                """, new { recordId }, cancellationToken: ct));
        if (current is null) throw new NexusNotFoundException("Record not found.");
        var drum = current.Value;

        await ProductionEventLogHelper.WriteEventAsync(connection, "DR", recordId, "NOTE", $"Retry by supervisor {userId}", 0, userId, ct);

        // BOM-vs-traceability re-check — a drum can land in this queue
        // specifically because it was BLOCKED (not a real SAP failure) by
        // the pre-backflush check in DrummingHelper.SubmitAsync; re-check
        // fresh here (a concession may have been approved since, or
        // "Refresh BOM" may have resolved it) before retrying, same gate as
        // the original submission — but against the persisted BOM snapshot,
        // not a fresh SAP re-download (this is a retry of the SAME job, not
        // a new submission).
        var drTraceRows = await BomHelper.GetParentBatchLinksAsync(connection, "DR", recordId, ct);
        var drBomRows = await BomHelper.LatestBomSnapshotAsync(connection, "DR", recordId, ct);
        var drProblems = await BomHelper.ValidateTraceabilityAgainstBomAsync(connection, drTraceRows, drBomRows, ct);
        var drBlocking = await BomHelper.UnresolvedProblemsAsync(connection, "DR", recordId, drProblems, ct);
        var drRawProblems = await BomHelper.ValidateRawMaterialBatchesAsync(connection, "DR", recordId, drBomRows, ct);

        if (drBlocking.Count > 0 || drRawProblems.Count > 0)
        {
            var suffix = drBlocking.Count > 0
                ? " Raise a concession from the traceability screen, or use \"Refresh BOM\" if SAP's BOM has since been corrected."
                : "";
            var errMsg = $"Still blocked: {string.Join(" ", drBlocking.Concat(drRawProblems).Select(p => p.Reason))}{suffix}";
            return new FailedBackflushRetryResult("BLOCKED", null, false, errMsg, null);
        }

        var drConcessions = drProblems.Count > 0
            ? await BomHelper.ApprovedConcessionsAsync(connection, "DR", recordId, ct)
            : [];

        string? sapMatDoc;
        string? messageNumber = null;
        var concessionApplied = false;

        if (drConcessions.Count > 0)
        {
            var components = BomHelper.BuildActualComponentList(drBomRows, drConcessions, drum.LengthMetres);
            var sapComponents = components.Select(c => new SapGoodsMovementComponent(c.Material, c.Quantity, c.Unit, c.StorageLocation)).ToList();

            var gmResponse = await sap.PostAsync<SapGoodsMovementResponse>("api/production/goods-movement-backflush",
                new SapGoodsMovementRequest(drum.Material, drum.DrumRef, sapComponents), userId, ct: ct);

            if (gmResponse is null || !gmResponse.Success || string.IsNullOrEmpty(gmResponse.MaterialDocument))
            {
                var msg = gmResponse?.Messages is { Count: > 0 } msgs
                    ? string.Join(" ", msgs.Select(m => m.Message).Where(m => !string.IsNullOrEmpty(m)))
                    : "";
                throw new InvalidOperationException(string.IsNullOrEmpty(msg) ? "Goods movement rejected — no material document returned." : msg);
            }

            sapMatDoc = gmResponse.MaterialDocument;
            concessionApplied = true;
            await audit.LogAsync("SAP_OK", username, $"'{drum.DrumRef}' BACKFLUSHED (concession, goods movement, retry) - Material Document = '{sapMatDoc}'", ipAddress, ct);

            foreach (var c in drConcessions)
            {
                await connection.ExecuteAsync(new CommandDefinition(
                    "UPDATE prod.TraceabilityConcessions SET AppliedAt = GETDATE(), MaterialDocumentSAP = @sapMatDoc WHERE ConcessionID = @concessionId",
                    new { sapMatDoc, concessionId = c.ConcessionId }, cancellationToken: ct));
            }
        }
        else
        {
            // Node's own retry route calls sapPost(`/drumming/${entryType}`, ...)
            // here — but sapPost always targets SapServer's base URL
            // (config.js's sapConfig.url), and SapServer has no /drumming/*
            // routes at all (confirmed directly against SapServer/Controllers/
            // ProductionController.cs — its real combined endpoint is
            // POST api/production/drumming-backflush, DrumBackflushRequest/
            // DrumBackflushResponse). The body Node sends there
            // (TotalLength/Order) doesn't even match that DTO's real field
            // names either. A genuine, confirmed dead/broken code path in
            // Node itself — every non-concession DR retry would 404 against
            // a real SapServer — not a deliberate quirk to preserve. Ported
            // to call the correct endpoint instead, matching exactly what
            // DrummingHelper.SubmitAsync's own non-concession branch does.
            var traceMaterials = await DrummingHelper.ResolveTraceabilityMaterialsAsync(connection,
                drTraceRows.Select(t => new ParentBatchRef(t.ProcessCode, t.RecordId)).ToList(), ct);

            var sapResponse = await sap.PostAsync<SapDrumBackflushResponse>("api/production/drumming-backflush",
                new SapDrumBackflushRequest(drum.Material, drum.LengthMetres, drum.DrumRef, drum.CustomerId ?? "", drum.PackagingType ?? "", drum.WeightKg ?? 0, traceMaterials), userId, ct: ct)
                ?? throw new InvalidOperationException("SapServer returned no backflush result.");

            var zf = sapResponse.Backflush;
            if (!(zf.Type == "S" && zf.MessageClass == "RM" && zf.MessageNumber is "190" or "191"))
            {
                throw new InvalidOperationException(zf.Message is { Length: > 0 } m ? m : $"SAP backflush rejected: {zf.Type} {zf.MessageClass} {zf.MessageNumber}");
            }

            sapMatDoc = sapResponse.MaterialDocument is { Length: > 0 } ? sapResponse.MaterialDocument : zf.DocumentNumber;
            messageNumber = zf.MessageNumber;
            await audit.LogAsync("SAP_OK", username, $"'{drum.DrumRef}' BACKFLUSHED - Material Document = '{sapMatDoc}'", ipAddress, ct);

            if (messageNumber == "190")
            {
                await ProductionSapHelpers.LogBackflushAlertAsync(connection, "DR", recordId, drum.DrumRef, sapMatDoc, messageNumber, zf.Message, ct);
                await ProductionEventLogHelper.WriteEventAsync(connection, "DR", recordId, "NOTE",
                    $"SAP 190 on retry: No component consumption — MatDoc: {sapMatDoc}. Flagged for data review.", 1, userId, ct);
            }
        }

        await connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,MaterialDocumentSAP,IsSuccess,PostedByUserID)
            VALUES ('DR',@recordId,'BACKFLUSH',@length,'M',@sapMatDoc,1,@userId)
            """, new { recordId, length = drum.LengthMetres, sapMatDoc, userId }, cancellationToken: ct));

        await connection.ExecuteAsync(new CommandDefinition("UPDATE prod.Drumming SET Status = 4 WHERE DrummingID = @recordId", new { recordId }, cancellationToken: ct));

        await ProductionEventLogHelper.WriteEventAsync(connection, "DR", recordId, "SAP_POST",
            $"Retry succeeded{(concessionApplied ? " via concession goods movement" : "")} — MatDoc: {sapMatDoc}{(messageNumber == "190" ? " (190: no components consumed)" : "")}", 0, userId, ct);

        var warning = messageNumber == "190" ? "SAP 190: posted but no components consumed — flagged for data review." : null;
        return new FailedBackflushRetryResult("COMPLETE", sapMatDoc, concessionApplied, warning, null);
    }

    /// <summary>EX/CO/BR/CL/TW — a plain ZF40N retry. EX additionally re-gates on MX-tub staging (the same wizard check), optionally replacing which tub(s) this run traces back to first if the caller supplied a fresh ParentBatches array — lets a supervisor either fix the underlying mix or repoint the link entirely before retrying.</summary>
    private static async Task<FailedBackflushRetryResult> RetryMetreProcessAsync(
        SqlConnection connection, ISapServerClient sap, IAuditLogger audit, string code, int recordId,
        FailedBackflushRetryRequest body, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        var (table, pk, refCol, _, _) = ProductionSapHelpers.Process[code];

        await connection.ExecuteAsync(new CommandDefinition($"""
            UPDATE {table} SET
                Material = COALESCE(@material, Material),
                LengthMetres = COALESCE(@lengthMetres, LengthMetres),
                Notes = COALESCE(@notes, Notes)
            WHERE {pk} = @recordId
            """, new { material = body.Material, lengthMetres = body.LengthMetres, notes = body.Notes, recordId }, cancellationToken: ct));

        var current = await connection.QuerySingleOrDefaultAsync<(string BatchRef, string Material, decimal LengthMetres)?>(
            new CommandDefinition($"SELECT {refCol} AS BatchRef, Material, LengthMetres FROM {table} WHERE {pk} = @recordId", new { recordId }, cancellationToken: ct));
        if (current is null) throw new NexusNotFoundException("Record not found.");
        var rec = current.Value;

        if (code == "EX")
        {
            if (body.ParentBatches is not null)
            {
                await connection.ExecuteAsync(new CommandDefinition(
                    "DELETE FROM prod.ProductionTrace WHERE ChildProcessCode = @code AND ChildRecordID = @recordId AND ParentProcessCode = N'MX'",
                    new { code, recordId }, cancellationToken: ct));

                foreach (var pb in body.ParentBatches)
                {
                    if (string.IsNullOrWhiteSpace(pb.ProcessCode) || pb.RecordId is null || !string.Equals(pb.ProcessCode, "MX", StringComparison.OrdinalIgnoreCase)) continue;
                    await connection.ExecuteAsync(new CommandDefinition("""
                        INSERT INTO prod.ProductionTrace (ChildProcessCode,ChildRecordID,ParentProcessCode,ParentRecordID,ParentTubID,LinkedByUserID)
                        VALUES (@code,@recordId,N'MX',@parentRecordId,@parentTubId,@userId)
                        """, new { code, recordId, parentRecordId = pb.RecordId.Value, parentTubId = pb.TubId, userId }, cancellationToken: ct));
                }
            }

            var mxParentRows = await connection.QueryAsync<(int RecordId, int? TubId)>(new CommandDefinition("""
                SELECT ParentRecordID AS RecordId, ParentTubID AS TubId FROM prod.ProductionTrace
                WHERE ChildProcessCode = @code AND ChildRecordID = @recordId AND ParentProcessCode = N'MX'
                """, new { code, recordId }, cancellationToken: ct));
            var mxParentBatches = mxParentRows.Select(r => new ParentBatchRef("MX", r.RecordId, r.TubId)).ToList();

            if (mxParentBatches.Count > 0)
            {
                try { await MetreProcessHelper.ApportionMxExpectedConsumptionAsync(connection, sap, code, recordId, rec.Material, rec.LengthMetres, userId, ct); }
                catch { /* purely a reporting figure — never gates or decrements anything, matches Node's .catch(() => {}) */ }

                var problems = await MetreProcessHelper.ValidateMxTubLinksAsync(connection, sap, rec.Material, mxParentBatches, userId, ct);
                if (problems.Count > 0)
                {
                    throw new NexusConflictException($"Cannot retry — {string.Join(" ", problems.Select(p => p.Reason))} Stage the tub, override its expiry, or change the linked tub.");
                }
            }
        }

        await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "NOTE", $"Retry by supervisor {userId}", 0, userId, ct);

        var sapResponse = await sap.PostAsync<BdcResponse>("api/production/backflush",
            new Zf40nRequest(rec.Material, rec.LengthMetres, rec.BatchRef, "", "", ""), userId, ct: ct)
            ?? throw new InvalidOperationException("SapServer returned no backflush result.");
        var sapMatDoc = ProductionSapHelpers.ParseSapBackflush(sapResponse);
        await audit.LogAsync("SAP_OK", username, $"'{rec.BatchRef}' BACKFLUSHED - Material Document = '{sapMatDoc}'", ipAddress, ct);

        if (sapResponse.MessageNumber == "190")
        {
            await ProductionSapHelpers.LogBackflushAlertAsync(connection, code, recordId, rec.BatchRef, sapMatDoc, sapResponse.MessageNumber, sapResponse.Message, ct);
            await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "NOTE", $"SAP 190 on retry: No component consumption — MatDoc: {sapMatDoc}.", 1, userId, ct);
        }

        await connection.ExecuteAsync(new CommandDefinition($"""
            INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,MaterialDocumentSAP,IsSuccess,PostedByUserID)
            VALUES (@code,@recordId,'BACKFLUSH',@length,'M',@sapMatDoc,1,@userId)
            """, new { code, recordId, length = rec.LengthMetres, sapMatDoc, userId }, cancellationToken: ct));

        await connection.ExecuteAsync(new CommandDefinition($"UPDATE {table} SET Status = 4 WHERE {pk} = @recordId", new { recordId }, cancellationToken: ct));

        await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "SAP_POST", $"Retry succeeded — MatDoc: {sapMatDoc}", 0, userId, ct);

        return new FailedBackflushRetryResult("COMPLETE", sapMatDoc, false, null, null);
    }

    /// <summary>EW — no SAP call at all; "retry" here just means a supervisor reviewed the record and marked it complete. Shared shape with HA below, minus HA's extra SalesOrderSAP field.</summary>
    private static async Task<FailedBackflushRetryResult> RetryMarkCompleteAsync(
        SqlConnection connection, string code, string pk, string table, int recordId, string? material, string? notes, int userId, CancellationToken ct)
    {
        await connection.ExecuteAsync(new CommandDefinition($"""
            UPDATE {table} SET Material = COALESCE(@material, Material), Notes = COALESCE(@notes, Notes), Status = 4
            WHERE {pk} = @recordId
            """, new { material, notes, recordId }, cancellationToken: ct));

        await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "NOTE",
            $"Supervisor {userId} reviewed and marked complete from failed-backflush queue", 0, userId, ct);

        return new FailedBackflushRetryResult("COMPLETE", null, false, null, null);
    }

    /// <summary>HA — same "mark reviewed and complete" shape as EW, plus an editable SalesOrderSAP field.</summary>
    private static async Task<FailedBackflushRetryResult> RetryHoseAssemblyAsync(
        SqlConnection connection, int recordId, FailedBackflushRetryRequest body, int userId, CancellationToken ct)
    {
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE prod.HoseAssembly SET
                Material = COALESCE(@material, Material),
                SalesOrderSAP = COALESCE(@salesOrderSap, SalesOrderSAP),
                Notes = COALESCE(@notes, Notes), Status = 4
            WHERE HoseAssemblyID = @recordId
            """, new { material = body.Material, salesOrderSap = body.SalesOrderSap, notes = body.Notes, recordId }, cancellationToken: ct));

        await ProductionEventLogHelper.WriteEventAsync(connection, "HA", recordId, "NOTE",
            "Supervisor " + userId + " reviewed and marked complete from failed-backflush queue", 0, userId, ct);

        return new FailedBackflushRetryResult("COMPLETE", null, false, null, null);
    }

    /// <summary>PATCH /failed-backflush/:pc/:id/cancel — sets Status=5 (cancelled) if the record is still genuinely Status=6 (SAP_FAILED); a no-op, not an error, if it's since moved on (retried successfully, or already cancelled) — mirrors Node's own unconditional UPDATE-then-always-200 exactly, no rows-affected check.</summary>
    internal static async Task CancelAsync(INexusOperationsDb db, string processCode, int recordId, int userId, CancellationToken ct)
    {
        var code = processCode.ToUpperInvariant();
        if (!ProductionSapHelpers.Process.TryGetValue(code, out var cfg))
        {
            throw new NexusValidationException($"Unknown process code: {code}.");
        }

        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition($"UPDATE {cfg.Table} SET Status = 5 WHERE {cfg.Pk} = @recordId AND Status = 6", new { recordId }, cancellationToken: ct));
        await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "CANCELLED", $"Record cancelled by supervisor {userId} from failed-backflush queue", 0, userId, ct);
    }
}
