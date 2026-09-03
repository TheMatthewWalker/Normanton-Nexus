using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Production;

/// <summary>
/// The shared metre-process (EX/CO/BR/CL/TW) entry engine — port of the
/// "Generic entry" section of routes/productionnexus.js. See
/// MetreProcessModels.cs's header comment for this slice's scope (direct
/// entry + open-entries/data/open-runs; the draft/complete BOM-validated
/// workflow is deferred to Sub-phase 6c).
/// </summary>
internal static class MetreProcessHelper
{
    /// <summary>Every process eligible for Open Runs — spans beyond the 5 metre processes (includes MX/DR/EW/HA too), matching Node's OPEN_RUN_PROCESSES exactly.</summary>
    private static readonly string[] OpenRunProcesses = ["MX", "EX", "CO", "BR", "CL", "TW", "DR", "EW", "HA"];

    /// <summary>Processes whose table has an IsReversed column — everything except Ewald/HoseAssembly, matching Node's HAS_ISREVERSED exactly.</summary>
    private static readonly HashSet<string> HasIsReversed = new(StringComparer.OrdinalIgnoreCase) { "MX", "EX", "CO", "BR", "CL", "TW", "DR" };

    private static (string Table, string Pk, string Ref) RequireMetreProcess(string processCode)
    {
        var code = processCode.ToUpperInvariant();
        if (!ProductionSapHelpers.MetreProcesses.Contains(code))
        {
            throw new NexusValidationException($"{code} is not handled by this endpoint.");
        }
        var (table, pk, refCol, _, _) = ProductionSapHelpers.Process[code];
        return (table, pk, refCol);
    }

    /// <summary>notify() (SAP-failure alert to PROD_SUPERVISOR) is deliberately not wired up — same deferred-Notifications-feature reasoning as MixingHelper.EnterAsync.</summary>
    internal static async Task<MetreProcessEntryResult> EnterAsync(
        string processCode, INexusOperationsDb db, ISapServerClient sap, IAuditLogger audit,
        MetreProcessEntryRequest body, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        var (table, pk, refCol) = RequireMetreProcess(processCode);
        var code = processCode.ToUpperInvariant();

        var material = body.Material?.Trim();
        if (string.IsNullOrWhiteSpace(material) || body.LengthMetres is not (> 0))
        {
            throw new NexusValidationException("material and lengthMetres are required.");
        }
        var length = body.LengthMetres.Value;

        await ProductionSapHelpers.AssertProfitCentreAsync(sap, code, material, userId, ct);

        using var connection = await db.CreateConnectionAsync(ct);
        var shiftId = body.ShiftId ?? ProductionSapHelpers.CurrentShiftId();

        var recordId = await connection.QuerySingleAsync<int>(new CommandDefinition($"""
            INSERT INTO {table} (ShiftID, MachineID, Material, LengthMetres, Status, CompletedAt, CreatedByUserID, Notes)
            OUTPUT INSERTED.{pk}
            VALUES (@shiftId, @machineId, @material, @length, 4, GETDATE(), @userId, @notes)
            """, new { shiftId, machineId = body.MachineId, material, length, userId, notes = body.Notes }, cancellationToken: ct));

        var batchRef = $"{code}{recordId:D8}";

        await connection.ExecuteAsync(new CommandDefinition(
            "INSERT INTO prod.BatchOperators (ProcessCode, ProcessRecordID, UserID, IsPrimary, AssignedByUserID) VALUES (@code, @recordId, @userId, 1, @userId)",
            new { code, recordId, userId }, cancellationToken: ct));

        foreach (var additionalUserId in body.AdditionalOperatorIds ?? [])
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "INSERT INTO prod.BatchOperators (ProcessCode, ProcessRecordID, UserID, IsPrimary, AssignedByUserID) VALUES (@code, @recordId, @additionalUserId, 0, @userId)",
                new { code, recordId, additionalUserId, userId }, cancellationToken: ct));
        }

        foreach (var pb in body.ParentBatches ?? [])
        {
            if (string.IsNullOrWhiteSpace(pb.ProcessCode) || pb.RecordId is null) continue;
            await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO prod.ProductionTrace (ChildProcessCode, ChildRecordID, ParentProcessCode, ParentRecordID, LinkedByUserID)
                VALUES (@code, @recordId, @parentCode, @parentRecordId, @userId)
                """, new { code, recordId, parentCode = pb.ProcessCode.ToUpperInvariant(), parentRecordId = pb.RecordId.Value, userId }, cancellationToken: ct));
        }

        if (body.HasScrap && body.ScrapReasons is { Count: > 0 })
        {
            await RecordEntryScrapAsync(connection, code, recordId, body, userId, ct);
        }

        await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "STARTED", $"{code} record created: {material} {length:F3} M", 0, userId, ct);

        try
        {
            var sapResponse = await sap.PostAsync<BdcResponse>("api/production/backflush", new Zf40nRequest(
                Material: material, Quantity: length, Header: batchRef, Packaging: "", Charge: "", Customer: ""), userId, ct: ct)
                ?? throw new NexusBadGatewayException("SapServer returned no backflush result.");

            var sapMatDoc = ProductionSapHelpers.ParseSapBackflush(sapResponse);
            await audit.LogAsync("SAP_OK", username, $"'{batchRef}' BACKFLUSHED - Material Document = '{sapMatDoc}'", ipAddress, ct);

            string? warning = null;
            if (sapResponse.MessageNumber == "190")
            {
                await ProductionSapHelpers.LogBackflushAlertAsync(connection, code, recordId, batchRef, sapMatDoc, sapResponse.MessageNumber, sapResponse.Message, ct);
                await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "NOTE",
                    $"SAP 190: No component consumption — MatDoc: {sapMatDoc}. Flagged for data review.", 1, userId, ct);
                warning = "SAP 190: posted but no components consumed — flagged for data review.";
            }

            await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO prod.SAPPostings (ProcessCode, ProcessRecordID, PostingType, Quantity, UnitOfMeasure, MaterialDocumentSAP, IsSuccess, PostedByUserID)
                VALUES (@code, @recordId, 'BACKFLUSH', @length, 'M', @sapMatDoc, 1, @userId)
                """, new { code, recordId, length, sapMatDoc, userId }, cancellationToken: ct));

            await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "SAP_POST",
                $"Backflush posted — MatDoc: {sapMatDoc}{(sapResponse.MessageNumber == "190" ? " (190: no components consumed)" : "")}", 0, userId, ct);

            return new MetreProcessEntryResult(recordId, batchRef, sapMatDoc, "COMPLETE", warning, null);
        }
        catch (Exception sapErr) when (sapErr is not NexusValidationException)
        {
            await connection.ExecuteAsync(new CommandDefinition($"UPDATE {table} SET Status = 6 WHERE {pk} = @recordId", new { recordId }, cancellationToken: ct));

            var errMsg = sapErr.Message;
            await audit.LogAsync("SAP_ERROR", username, $"'{batchRef}' FAILED - Message = \"{errMsg}\"", ipAddress, ct);

            await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO prod.SAPPostings (ProcessCode, ProcessRecordID, PostingType, Quantity, UnitOfMeasure, IsSuccess, ErrorMessage, PostedByUserID)
                VALUES (@code, @recordId, 'BACKFLUSH', @length, 'M', 0, @errMsg, @userId)
                """, new { code, recordId, length, errMsg, userId }, cancellationToken: ct));

            await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "SAP_FAIL", $"SAP backflush failed: {errMsg}", 2, userId, ct);

            return new MetreProcessEntryResult(recordId, batchRef, null, "SAP_FAILED", "Record saved but SAP backflush failed. See failed backflush queue.", errMsg);
        }
    }

    /// <summary>EX scrap entry — delegates to the shared RecordScrapAsync core (also used by CompleteAsync's own scrap step).</summary>
    private static Task RecordEntryScrapAsync(Microsoft.Data.SqlClient.SqlConnection connection, string code, int recordId, MetreProcessEntryRequest body, int userId, CancellationToken ct) =>
        RecordScrapAsync(connection, code, recordId, body.ScrapTotalKg, body.ScrapReasons!, userId, ct);

    /// <summary>
    /// EX scrap is entered per-reason in real KG; every other metre process
    /// only records an overall total plus reason occurrence counts, so each
    /// reason's KG share is derived proportionally — mirrors Node's own
    /// two-branch logic (code === 'EX' vs the rest) exactly, not
    /// unified into one formula. Shared by both EnterAsync's (direct entry)
    /// and CompleteAsync's (draft→complete wizard) scrap step — Node itself
    /// duplicates this logic inline in both routes; consolidated here into
    /// one method rather than mechanically re-duplicating it a third time.
    /// Also reused directly by DrummingHelper.SubmitAsync (Drumming is never
    /// "EX", so it always takes the proportional-share branch — the same
    /// math Node's own submitDrumming duplicates inline a third time).
    /// </summary>
    internal static async Task RecordScrapAsync(Microsoft.Data.SqlClient.SqlConnection connection, string code, int recordId, decimal? scrapTotalKg, IReadOnlyList<ScrapReasonInput> reasons, int userId, CancellationToken ct)
    {
        if (code == "EX")
        {
            foreach (var r in reasons)
            {
                var qty = Math.Round((r.Kg ?? 0) * 1000) / 1000;
                if (r.ReasonId is null || qty <= 0) continue;
                await InsertScrapEntryAsync(connection, code, recordId, r.ReasonId.Value, qty, userId, ct);
            }
        }
        else
        {
            var totalOccurrences = reasons.Sum(r => r.Occurrences ?? 0);
            foreach (var r in reasons)
            {
                if (r.ReasonId is null) continue;
                var share = totalOccurrences > 0 ? (r.Occurrences ?? 0) / (decimal)totalOccurrences : 1m;
                var qty = Math.Round((scrapTotalKg ?? 0) * share * 1000) / 1000;
                await InsertScrapEntryAsync(connection, code, recordId, r.ReasonId.Value, qty, userId, ct);
            }
        }

        await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "SCRAP",
            $"Scrap recorded: {scrapTotalKg} KG across {reasons.Count} reason(s)", 1, userId, ct);
    }

    private static Task InsertScrapEntryAsync(Microsoft.Data.SqlClient.SqlConnection connection, string code, int recordId, int reasonId, decimal qty, int userId, CancellationToken ct) =>
        connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO prod.ScrapEntries (ProcessCode, ProcessRecordID, ReasonID, Quantity, UnitOfMeasure, EnteredByUserID)
            VALUES (@code, @recordId, @reasonId, @qty, 'KG', @userId)
            """, new { code, recordId, reasonId, qty, userId }, cancellationToken: ct));

    internal static async Task<IReadOnlyList<OpenEntryRow>> GetOpenEntriesAsync(string processCode, INexusOperationsDb db, CancellationToken ct)
    {
        var (table, pk, refCol) = RequireMetreProcess(processCode);

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<OpenEntryRow>(new CommandDefinition($"""
            SELECT t.{pk} AS RecordId, t.{refCol} AS BatchRef, t.Material, t.MachineID AS MachineId, m.MachineCode, m.MachineName,
                   t.Notes, t.CreatedAt, pu.Username AS CreatedBy
            FROM {table} t
            LEFT JOIN prod.Machines m ON m.MachineID = t.MachineID
            LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = t.CreatedByUserID
            WHERE t.Status = 1 AND t.IsReversed = 0
            ORDER BY t.CreatedAt DESC
            """, cancellationToken: ct));
        return rows.ToArray();
    }

    internal static async Task<IReadOnlyList<MetreProcessDataRow>> GetDataAsync(string processCode, INexusOperationsDb db, MetreProcessDataQuery query, CancellationToken ct)
    {
        var (table, pk, refCol) = RequireMetreProcess(processCode);

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<MetreProcessDataRow>(new CommandDefinition($"""
            SELECT t.{pk} AS RecordId, t.{refCol} AS BatchRef, t.ShiftID AS ShiftId, s.ShiftName,
                   t.MachineID AS MachineId, m.MachineCode, m.MachineName,
                   t.Material, t.LengthMetres, t.Status, t.IsReversed, sc.StatusName,
                   t.StartedAt, t.CompletedAt, t.Notes, pu.Username AS CreatedBy
            FROM {table} t
            LEFT JOIN prod.Shifts s ON s.ShiftID = t.ShiftID
            LEFT JOIN prod.Machines m ON m.MachineID = t.MachineID
            LEFT JOIN prod.StatusCodes sc ON sc.StatusID = t.Status
            LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = t.CreatedByUserID
            WHERE (@material IS NULL OR t.Material LIKE @material)
              AND (@from IS NULL OR t.StartedAt >= @from)
              AND (@to IS NULL OR t.StartedAt <= @to)
            ORDER BY t.StartedAt DESC
            """, new
        {
            material = string.IsNullOrWhiteSpace(query.Material) ? null : $"%{query.Material}%",
            from = DateTime.TryParse(query.DateFrom, out var from) ? from : (DateTime?)null,
            to = DateTime.TryParse(query.DateTo, out var to) ? to : (DateTime?)null,
        }, cancellationToken: ct));
        return rows.ToArray();
    }

    internal static async Task<IReadOnlyList<OpenRunRow>> GetOpenRunsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        var unionParts = OpenRunProcesses.Select(code =>
        {
            var (table, pk, refCol, _, _) = ProductionSapHelpers.Process[code];
            var reversedFilter = HasIsReversed.Contains(code) ? "AND t.IsReversed = 0" : "";
            return $"""
                SELECT N'{code}' AS ProcessCode, t.{pk} AS RecordId, t.{refCol} AS BatchRef, t.Material, t.CreatedAt, pu.Username AS CreatedBy
                FROM {table} t
                LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = t.CreatedByUserID
                WHERE t.Status = 1 {reversedFilter}
                """;
        });
        var sql = string.Join("\nUNION ALL\n", unionParts) + "\nORDER BY CreatedAt DESC";

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<OpenRunRow>(new CommandDefinition(sql, cancellationToken: ct));
        return rows.ToArray();
    }

    internal static async Task CancelOpenRunAsync(string processCode, int recordId, INexusOperationsDb db, CancelOpenRunRequest body, int userId, CancellationToken ct)
    {
        var code = processCode.ToUpperInvariant();
        if (!ProductionSapHelpers.Process.TryGetValue(code, out var cfg))
        {
            throw new NexusValidationException($"Unknown process code: {code}");
        }

        using var connection = await db.CreateConnectionAsync(ct);
        var rowsAffected = await connection.ExecuteAsync(new CommandDefinition(
            $"UPDATE {cfg.Table} SET Status = 5 WHERE {cfg.Pk} = @recordId AND Status = 1",
            new { recordId }, cancellationToken: ct));

        if (rowsAffected == 0)
        {
            throw new NexusConflictException("Record is not open — it may already be completed or cancelled.");
        }

        var reason = body.Reason?.Trim();
        await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "CANCELLED",
            $"Open run cancelled by supervisor{(string.IsNullOrEmpty(reason) ? "" : $" — {reason}")}", 0, userId, ct);
    }

    // ── Draft → Complete two-step wizard (BOM-validated traceability) ────────
    // Sub-phase 6c. Distinct from EnterAsync (direct one-step entry, no BOM
    // work at all) — see MetreProcessModels.cs's header comment.

    /// <summary>POST /process/:pc/draft — creates an open (Status=1) run, links any parent batches, and (for CO/BR/CL/TW) downloads+persists a BOM snapshot with non-blocking traceability warnings; (for EX) runs the separate MX-tub-staging-aware check instead. Mirrors Node's draft route exactly, including BOM-lookup failure becoming a warning, not a hard error — nothing here blocks creating the open run.</summary>
    internal static async Task<MetreDraftResult> DraftAsync(
        string processCode, INexusOperationsDb db, ISapServerClient sap, MetreDraftRequest body, int userId, CancellationToken ct)
    {
        var (table, pk, _) = RequireMetreProcess(processCode);
        var code = processCode.ToUpperInvariant();

        var material = body.Material?.Trim();
        if (string.IsNullOrWhiteSpace(material))
        {
            throw new NexusValidationException("material is required.");
        }

        // Reject wrong-profit-centre materials at setup, not just at
        // completion — otherwise the operator creates an open run they can
        // never complete.
        await ProductionSapHelpers.AssertProfitCentreAsync(sap, code, material, userId, ct);

        using var connection = await db.CreateConnectionAsync(ct);
        var shiftId = ProductionSapHelpers.CurrentShiftId();

        var recordId = await connection.QuerySingleAsync<int>(new CommandDefinition($"""
            INSERT INTO {table} (ShiftID, MachineID, Material, LengthMetres, Status, CreatedByUserID, Notes)
            OUTPUT INSERTED.{pk}
            VALUES (@shiftId, @machineId, @material, 0, 1, @userId, @notes)
            """, new { shiftId, machineId = body.MachineId, material, userId, notes = body.Notes }, cancellationToken: ct));

        var batchRef = $"{code}{recordId:D8}";

        await connection.ExecuteAsync(new CommandDefinition(
            "INSERT INTO prod.BatchOperators (ProcessCode, ProcessRecordID, UserID, IsPrimary, AssignedByUserID) VALUES (@code, @recordId, @userId, 1, @userId)",
            new { code, recordId, userId }, cancellationToken: ct));

        var parentBatches = body.ParentBatches ?? [];
        foreach (var pb in parentBatches)
        {
            if (string.IsNullOrWhiteSpace(pb.ProcessCode) || pb.RecordId is null) continue;
            var isMxTub = string.Equals(pb.ProcessCode, "MX", StringComparison.OrdinalIgnoreCase) && pb.TubId is not null;
            await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO prod.ProductionTrace (ChildProcessCode, ChildRecordID, ParentProcessCode, ParentRecordID, ParentTubID, LinkedByUserID)
                VALUES (@code, @recordId, @parentCode, @parentRecordId, @parentTubId, @userId)
                """, new
            {
                code,
                recordId,
                parentCode = pb.ProcessCode.ToUpperInvariant(),
                parentRecordId = pb.RecordId.Value,
                parentTubId = isMxTub ? pb.TubId : null,
                userId
            }, cancellationToken: ct));
        }

        if (BomHelper.BomValidatedProcesses.Contains(code))
        {
            await BomHelper.PersistRawMaterialBatchesAsync(connection, code, recordId, userId, body.RawMaterialBatches ?? [], ct);
        }

        await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "STARTED", $"{code} open entry created: {material}", 0, userId, ct);

        // Informational only at draft time — a mix not yet staged, or a BOM
        // that can't be verified yet, doesn't block creating the open run,
        // it just warns the operator now rather than only discovering it at
        // completion. Hard-blocked later at completion time instead — see
        // CompleteAsync.
        var warnings = new List<string>();
        if (code == "EX")
        {
            var mxParents = parentBatches.Where(pb => string.Equals(pb.ProcessCode, "MX", StringComparison.OrdinalIgnoreCase) && pb.RecordId is not null).ToList();
            try
            {
                var problems = await ValidateMxTubLinksAsync(connection, sap, material, mxParents, userId, ct);
                warnings.AddRange(problems.Select(p => p.Reason));
            }
            catch { /* matches Node's .catch(() => []) around validateMxTubLinks */ }
        }
        else if (BomHelper.BomValidatedProcesses.Contains(code))
        {
            try
            {
                var bomRows = await BomHelper.FetchBomAsync(sap, material, userId, ct);
                await BomHelper.PersistBomSnapshotAsync(connection, code, recordId, material, bomRows, ct);

                var parentLinks = parentBatches
                    .Where(pb => !string.IsNullOrWhiteSpace(pb.ProcessCode) && pb.RecordId is not null)
                    .Select(pb => new ParentBatchLink(pb.ProcessCode!, pb.RecordId!.Value))
                    .ToList();

                var linkProblems = await BomHelper.ValidateTraceabilityAgainstBomAsync(connection, parentLinks, bomRows, ct);
                var rawProblems = await BomHelper.ValidateRawMaterialBatchesAsync(connection, code, recordId, bomRows, ct);
                warnings.AddRange(linkProblems.Select(p => p.Reason));
                warnings.AddRange(rawProblems.Select(p => p.Reason));
            }
            catch (Exception ex)
            {
                warnings.Add($"Unable to download BOM for {material} — SAP BOM lookup failed ({ex.Message}). Traceability cannot be verified yet.");
            }
        }

        return new MetreDraftResult(recordId, batchRef, warnings.Count > 0 ? warnings : null);
    }

    /// <summary>
    /// POST /process/:pc/complete/:recordId — the hard-block-vs-concession
    /// completion step. Mirrors Node's complete route exactly: re-validates
    /// traceability fresh against the latest persisted BOM (not anything
    /// computed at draft time), hard-blocks on anything unresolved (raw-
    /// material batches are never concession-eligible), then — for a job
    /// with at least one approved concession — posts every BOM component
    /// explicitly via goods-movement-backflush instead of the normal
    /// automatic ZF40N backflush. BR never posts its own backflush (early
    /// return after the traceability check) but still gets that check, same
    /// as every other BOM-validated process — it consumes real raw material
    /// even though the work centre's own SAP BOM data is unreliable for the
    /// backflush itself. A SAP failure (or a hard block) returns
    /// Status="SAP_FAILED" rather than throwing — same "the record was
    /// saved, only the SAP posting failed" convention every other
    /// Production write action uses; Node returns HTTP 200 for this case
    /// too, never an error status.
    /// </summary>
    internal static async Task<MetreCompleteResult> CompleteAsync(
        string processCode, int recordId, INexusOperationsDb db, ISapServerClient sap, IAuditLogger audit,
        MetreCompleteRequest body, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        var (table, pk, _) = RequireMetreProcess(processCode);
        var code = processCode.ToUpperInvariant();

        if (body.LengthMetres is not (> 0))
        {
            throw new NexusValidationException("lengthMetres is required.");
        }
        var length = body.LengthMetres.Value;

        using var connection = await db.CreateConnectionAsync(ct);

        var check = await connection.QuerySingleOrDefaultAsync<(string Material, int Status)?>(new CommandDefinition(
            $"SELECT Material, Status FROM {table} WHERE {pk} = @recordId", new { recordId }, cancellationToken: ct));

        if (check is null) throw new NexusNotFoundException("Record not found.");
        if (check.Value.Status != 1) throw new NexusConflictException("Record is not open — it may already be complete or cancelled.");

        var material = check.Value.Material;
        var batchRef = $"{code}{recordId:D8}";

        // Batch may predate the profit-centre rule — validate again before posting.
        await ProductionSapHelpers.AssertProfitCentreAsync(sap, code, material, userId, ct);

        var shiftId = body.ShiftId ?? ProductionSapHelpers.CurrentShiftId();
        await connection.ExecuteAsync(new CommandDefinition($"""
            UPDATE {table} SET LengthMetres = @length, ShiftID = @shiftId, Status = 4, CompletedAt = GETDATE(), Notes = COALESCE(@notes, Notes)
            WHERE {pk} = @recordId
            """, new { length, shiftId, notes = body.Notes, recordId }, cancellationToken: ct));

        foreach (var additionalUserId in body.AdditionalOperatorIds ?? [])
        {
            try
            {
                await connection.ExecuteAsync(new CommandDefinition(
                    "INSERT INTO prod.BatchOperators (ProcessCode, ProcessRecordID, UserID, IsPrimary, AssignedByUserID) VALUES (@code, @recordId, @additionalUserId, 0, @userId)",
                    new { code, recordId, additionalUserId, userId }, cancellationToken: ct));
            }
            catch { /* ignore duplicate operator, matches Node's try/catch swallow */ }
        }

        if (body.HasScrap && body.ScrapReasons is { Count: > 0 })
        {
            await RecordScrapAsync(connection, code, recordId, body.ScrapTotalKg, body.ScrapReasons, userId, ct);
        }

        await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "STARTED", $"{code} completed: {material} {length:F3} M", 0, userId, ct);

        // BOM-vs-traceability hard block — CO/BR/CL/TW/DR (not EX, which has
        // its own separate MX-tub-staging-aware check below). Re-reads the
        // actual linked parents fresh from prod.ProductionTrace and the
        // job's latest persisted BOM snapshot, so a since-corrected BOM
        // ("Refresh BOM") is picked up here too. An APPROVED concession
        // clears its own specific mismatch; anything still unresolved
        // blocks completion outright.
        List<BomRow> bomRows = [];
        List<ApprovedConcessionRow> jobConcessions = [];
        if (BomHelper.BomValidatedProcesses.Contains(code))
        {
            var parentLinks = await BomHelper.GetParentBatchLinksAsync(connection, code, recordId, ct);
            bomRows = (await BomHelper.LatestBomSnapshotAsync(connection, code, recordId, ct)).ToList();
            var problems = await BomHelper.ValidateTraceabilityAgainstBomAsync(connection, parentLinks, bomRows, ct);
            var blocking = await BomHelper.UnresolvedProblemsAsync(connection, code, recordId, problems, ct);

            // Raw-material BOM components have no portal record to concede
            // against — a missing hand-written batch number always blocks,
            // never bypassable via a concession.
            var rawProblems = await BomHelper.ValidateRawMaterialBatchesAsync(connection, code, recordId, bomRows, ct);

            if (blocking.Count > 0 || rawProblems.Count > 0)
            {
                var reasons = string.Join(" ", blocking.Concat(rawProblems).Select(p => p.Reason));
                var suffix = blocking.Count > 0
                    ? " Raise a concession from the traceability screen, or use \"Refresh BOM\" if SAP's BOM has since been corrected."
                    : "";
                return await MarkMetreSapFailedAsync(connection, audit, table, pk, code, recordId, batchRef, length, $"Blocked: {reasons}{suffix}", username, ipAddress, userId, ct);
            }

            if (problems.Count > 0)
            {
                jobConcessions = (await BomHelper.ApprovedConcessionsAsync(connection, code, recordId, ct)).ToList();
            }
        }

        if (code == "BR")
        {
            return new MetreCompleteResult(recordId, batchRef, null, "COMPLETE", false, null, null);
        }

        // Billet-staging gate — EX only (mix material only flows into
        // Extrusion in the real value stream). A problem here skips the SAP
        // call entirely, landing this exactly where a real SAP failure
        // would (Status=6, failed-backflush queue).
        if (code == "EX")
        {
            var mxParentRows = await connection.QueryAsync<(int RecordId, int? TubId)>(new CommandDefinition("""
                SELECT ParentRecordID AS RecordId, ParentTubID AS TubId
                FROM prod.ProductionTrace
                WHERE ChildProcessCode = @code AND ChildRecordID = @recordId AND ParentProcessCode = N'MX'
                """, new { code, recordId }, cancellationToken: ct));
            var mxParentBatches = mxParentRows.Select(r => new ParentBatchRef("MX", r.RecordId, r.TubId)).ToList();

            if (mxParentBatches.Count > 0)
            {
                try { await ApportionMxExpectedConsumptionAsync(connection, sap, code, recordId, material, length, userId, ct); }
                catch { /* purely a reporting figure — never gates or decrements anything, matches Node's .catch(() => {}) */ }

                var problems = await ValidateMxTubLinksAsync(connection, sap, material, mxParentBatches, userId, ct);
                if (problems.Count > 0)
                {
                    var errMsg = $"Blocked: {string.Join(" ", problems.Select(p => p.Reason))}";
                    return await MarkMetreSapFailedAsync(connection, audit, table, pk, code, recordId, batchRef, length, errMsg, username, ipAddress, userId, ct);
                }
            }
        }

        try
        {
            // Concession-covered jobs bypass the normal automatic BOM-driven
            // backflush entirely and post every component explicitly
            // instead (correct ones included) — see
            // BomHelper.BuildActualComponentList. Avoids the automatic
            // backflush also silently consuming the original wrong BOM
            // material on top of the explicit posting.
            if (jobConcessions.Count > 0)
            {
                var components = BomHelper.BuildActualComponentList(bomRows, jobConcessions, length);
                var sapComponents = components.Select(c => new SapGoodsMovementComponent(c.Material, c.Quantity, c.Unit, c.StorageLocation)).ToList();

                var gmResponse = await sap.PostAsync<SapGoodsMovementResponse>("api/production/goods-movement-backflush",
                    new SapGoodsMovementRequest(material, batchRef, sapComponents), userId, ct: ct);

                if (gmResponse is null || !gmResponse.Success || string.IsNullOrEmpty(gmResponse.MaterialDocument))
                {
                    var msg = gmResponse?.Messages is { Count: > 0 } msgs
                        ? string.Join(" ", msgs.Select(m => m.Message).Where(m => !string.IsNullOrEmpty(m)))
                        : "";
                    throw new InvalidOperationException(string.IsNullOrEmpty(msg) ? "Goods movement rejected — no material document returned." : msg);
                }

                var gmMatDoc = gmResponse.MaterialDocument;
                await audit.LogAsync("SAP_OK", username, $"'{batchRef}' BACKFLUSHED (concession, goods movement) - Material Document = '{gmMatDoc}'", ipAddress, ct);

                await connection.ExecuteAsync(new CommandDefinition("""
                    INSERT INTO prod.SAPPostings (ProcessCode, ProcessRecordID, PostingType, Quantity, UnitOfMeasure, MaterialDocumentSAP, IsSuccess, PostedByUserID)
                    VALUES (@code, @recordId, 'BACKFLUSH', @length, 'M', @gmMatDoc, 1, @userId)
                    """, new { code, recordId, length, gmMatDoc, userId }, cancellationToken: ct));

                var componentsDesc = string.Join(", ", components.Select(c => $"{c.Material} x{c.Quantity}"));
                await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "SAP_POST",
                    $"Backflush posted via concession goods movement — MatDoc: {gmMatDoc}. Components: {componentsDesc}.", 0, userId, ct);

                foreach (var concession in jobConcessions)
                {
                    await connection.ExecuteAsync(new CommandDefinition(
                        "UPDATE prod.TraceabilityConcessions SET AppliedAt = GETDATE(), MaterialDocumentSAP = @gmMatDoc WHERE ConcessionID = @concessionId",
                        new { gmMatDoc, concessionId = concession.ConcessionId }, cancellationToken: ct));
                }

                return new MetreCompleteResult(recordId, batchRef, gmMatDoc, "COMPLETE", true, null, null);
            }

            var sapResponse = await sap.PostAsync<BdcResponse>("api/production/backflush",
                new Zf40nRequest(material, length, batchRef, "", "", ""), userId, ct: ct)
                ?? throw new InvalidOperationException("SapServer returned no backflush result.");

            var backflushMatDoc = ProductionSapHelpers.ParseSapBackflush(sapResponse);
            await audit.LogAsync("SAP_OK", username, $"'{batchRef}' BACKFLUSHED - Material Document = '{backflushMatDoc}'", ipAddress, ct);

            string? warning = null;
            if (sapResponse.MessageNumber == "190")
            {
                await ProductionSapHelpers.LogBackflushAlertAsync(connection, code, recordId, batchRef, backflushMatDoc, sapResponse.MessageNumber, sapResponse.Message, ct);
                await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "NOTE",
                    $"SAP 190: No component consumption — MatDoc: {backflushMatDoc}. Flagged for data review.", 1, userId, ct);
                warning = "SAP 190: posted but no components consumed — flagged for data review.";
            }

            await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO prod.SAPPostings (ProcessCode, ProcessRecordID, PostingType, Quantity, UnitOfMeasure, MaterialDocumentSAP, IsSuccess, PostedByUserID)
                VALUES (@code, @recordId, 'BACKFLUSH', @length, 'M', @backflushMatDoc, 1, @userId)
                """, new { code, recordId, length, backflushMatDoc, userId }, cancellationToken: ct));

            await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "SAP_POST",
                $"Backflush posted — MatDoc: {backflushMatDoc}{(sapResponse.MessageNumber == "190" ? " (190: no components consumed)" : "")}", 0, userId, ct);

            return new MetreCompleteResult(recordId, batchRef, backflushMatDoc, "COMPLETE", false, warning, null);
        }
        catch (Exception sapErr) when (sapErr is not NexusApiException)
        {
            return await MarkMetreSapFailedAsync(connection, audit, table, pk, code, recordId, batchRef, length, sapErr.Message, username, ipAddress, userId, ct);
        }
    }

    /// <summary>Shared by every hard-block AND real-SAP-failure path in CompleteAsync — same function Node itself reuses for both (markSapFailed), including for a pure pre-SAP traceability block (no SAP call was even attempted). Always returns Status="SAP_FAILED" with HTTP 200 at the controller — never throws.</summary>
    private static async Task<MetreCompleteResult> MarkMetreSapFailedAsync(
        Microsoft.Data.SqlClient.SqlConnection connection, IAuditLogger audit, string table, string pk, string code, int recordId,
        string batchRef, decimal length, string errMsg, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        await connection.ExecuteAsync(new CommandDefinition($"UPDATE {table} SET Status = 6 WHERE {pk} = @recordId", new { recordId }, cancellationToken: ct));

        await audit.LogAsync("SAP_ERROR", username, $"'{batchRef}' FAILED - Message = \"{errMsg}\"", ipAddress, ct);

        await connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO prod.SAPPostings (ProcessCode, ProcessRecordID, PostingType, Quantity, UnitOfMeasure, IsSuccess, ErrorMessage, PostedByUserID)
            VALUES (@code, @recordId, 'BACKFLUSH', @length, 'M', 0, @errMsg, @userId)
            """, new { code, recordId, length, errMsg, userId }, cancellationToken: ct));

        await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "SAP_FAIL", $"SAP backflush failed: {errMsg}", 2, userId, ct);

        return new MetreCompleteResult(recordId, batchRef, null, "SAP_FAILED", false, "Record saved but SAP backflush failed. See failed backflush queue.", errMsg);
    }

    /// <summary>
    /// EX/MX's own separate, tub-staging-aware traceability check — deliberately
    /// NOT merged with BomHelper.ValidateTraceabilityAgainstBomAsync (the
    /// CO/BR/CL/TW/DR BOM-snapshot path), per Node's own comments: a linked
    /// MX parent is identified by a specific TubID (not just a MixingID),
    /// and must additionally be staged into Billet and not scrapped — checks
    /// with no equivalent for the other processes' plain parent-record
    /// links. Never throws — a BOM lookup failure becomes a single problem
    /// entry, matching Node's own internal catch exactly.
    /// </summary>
    private static async Task<IReadOnlyList<TraceabilityProblem>> ValidateMxTubLinksAsync(
        Microsoft.Data.SqlClient.SqlConnection connection, ISapServerClient sap, string extrudedMaterial, IReadOnlyList<ParentBatchRef> mxParents, int userId, CancellationToken ct)
    {
        if (mxParents.Count == 0) return [];

        List<SapBomRow> bomRows;
        try
        {
            bomRows = await sap.GetAsync<List<SapBomRow>>("api/production/bom", userId, new SapBomQuery(extrudedMaterial), ct: ct) ?? [];
        }
        catch
        {
            // BOM lookup itself failing is a SAP-availability problem, not a
            // traceability problem — surface it as its own single entry
            // rather than treating every linked tub as "wrong material".
            return [new TraceabilityProblem(null, null, null, $"Unable to verify BOM for {extrudedMaterial} — SAP BOM lookup failed.")];
        }
        var bomMaterials = bomRows.Select(r => r.Component).ToHashSet();

        async Task<string> MixRefForAsync(int mixingId)
        {
            var mixRef = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
                "SELECT MixRef FROM prod.Mixing WHERE MixingID = @mixingId", new { mixingId }, cancellationToken: ct));
            return mixRef ?? $"MX{mixingId:D8}";
        }

        var problems = new List<TraceabilityProblem>();
        foreach (var pb in mxParents)
        {
            var mixingId = pb.RecordId!.Value;

            if (pb.TubId is null)
            {
                problems.Add(new TraceabilityProblem(pb.ProcessCode, pb.RecordId, null,
                    $"No specific tub selected for {await MixRefForAsync(mixingId)} — pick a tub via the tub picker."));
                continue;
            }

            var tub = await connection.QuerySingleOrDefaultAsync<(int MixingId, int TubSeq, bool IsStaged, bool IsScrapped, string Material, string MixRef)?>(
                new CommandDefinition("""
                    SELECT t.MixingID AS MixingId, t.TubSeq, t.IsStaged, t.IsScrapped, m.Material, m.MixRef
                    FROM prod.MixingTubs t JOIN prod.Mixing m ON m.MixingID = t.MixingID
                    WHERE t.TubID = @tubId
                    """, new { tubId = pb.TubId.Value }, cancellationToken: ct));

            if (tub is null || tub.Value.MixingId != mixingId)
            {
                problems.Add(new TraceabilityProblem(pb.ProcessCode, pb.RecordId, null,
                    $"Tub not found, or does not belong to {await MixRefForAsync(mixingId)}."));
                continue;
            }

            var t = tub.Value;
            var label = $"{t.MixRef} tub {t.TubSeq}";
            if (t.IsScrapped) { problems.Add(new TraceabilityProblem(pb.ProcessCode, pb.RecordId, t.Material, $"{label} has been scrapped.")); continue; }
            if (!t.IsStaged) { problems.Add(new TraceabilityProblem(pb.ProcessCode, pb.RecordId, t.Material, $"{label} has not been staged into Billet yet.")); continue; }
            if (!bomMaterials.Contains(t.Material))
                problems.Add(new TraceabilityProblem(pb.ProcessCode, pb.RecordId, t.Material, $"{label}'s material ({t.Material}) is not a component of {extrudedMaterial}'s SAP BOM."));
        }
        return problems;
    }

    /// <summary>
    /// Populates ProductionTrace.ExpectedConsumptionKG for every MX-tub
    /// parent link on an Extrusion record — purely a reporting/reconciliation
    /// figure that never gates or decrements anything (see the caller's own
    /// swallowed-exception handling). When multiple linked tubs share the
    /// same component material, that material's BOM-derived total is split
    /// EQUALLY across them. Mirrors Node's apportionMxExpectedConsumption
    /// exactly.
    /// </summary>
    private static async Task ApportionMxExpectedConsumptionAsync(
        Microsoft.Data.SqlClient.SqlConnection connection, ISapServerClient sap, string code, int recordId, string extrudedMaterial, decimal lengthMetres, int userId, CancellationToken ct)
    {
        var traceRows = (await connection.QueryAsync<(int TraceId, string Material)>(new CommandDefinition("""
            SELECT tr.TraceID AS TraceId, t.Material
            FROM prod.ProductionTrace tr
            JOIN prod.MixingTubs t ON t.TubID = tr.ParentTubID
            WHERE tr.ChildProcessCode = @code AND tr.ChildRecordID = @recordId
              AND tr.ParentProcessCode = N'MX' AND tr.ParentTubID IS NOT NULL
            """, new { code, recordId }, cancellationToken: ct))).AsList();
        if (traceRows.Count == 0) return;

        // BOM unavailable — leave ExpectedConsumptionKG unset rather than guess.
        var bomRows = await sap.GetAsync<List<SapBomRow>>("api/production/bom", userId, new SapBomQuery(extrudedMaterial), ct: ct) ?? [];
        var bomByMaterial = bomRows.ToDictionary(r => r.Component, r => r.ComponentQty);

        foreach (var group in traceRows.GroupBy(r => r.Material))
        {
            if (!bomByMaterial.TryGetValue(group.Key, out var ratio) || ratio <= 0) continue; // not a real BOM component — ValidateMxTubLinksAsync already flags this

            var totalExpectedKg = Math.Round(ratio * lengthMetres, 3);
            var traceIds = group.Select(g => g.TraceId).ToList();
            var share = Math.Round(totalExpectedKg / traceIds.Count, 3);

            foreach (var traceId in traceIds)
            {
                await connection.ExecuteAsync(new CommandDefinition(
                    "UPDATE prod.ProductionTrace SET ExpectedConsumptionKG = @share WHERE TraceID = @traceId",
                    new { share, traceId }, cancellationToken: ct));
            }
        }
    }
}
