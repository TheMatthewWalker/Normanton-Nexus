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

    /// <summary>
    /// EX scrap is entered per-reason in real KG; every other metre process
    /// only records an overall total plus reason occurrence counts, so each
    /// reason's KG share is derived proportionally — mirrors Node's own
    /// two-branch logic (code === 'EX' vs the rest) exactly, not
    /// unified into one formula.
    /// </summary>
    private static async Task RecordEntryScrapAsync(Microsoft.Data.SqlClient.SqlConnection connection, string code, int recordId, MetreProcessEntryRequest body, int userId, CancellationToken ct)
    {
        var reasons = body.ScrapReasons!;

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
                var qty = Math.Round((body.ScrapTotalKg ?? 0) * share * 1000) / 1000;
                await InsertScrapEntryAsync(connection, code, recordId, r.ReasonId.Value, qty, userId, ct);
            }
        }

        await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "SCRAP",
            $"Scrap recorded: {body.ScrapTotalKg} KG across {reasons.Count} reason(s)", 1, userId, ct);
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
}
