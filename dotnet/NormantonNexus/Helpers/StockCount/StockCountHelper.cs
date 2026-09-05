using Dapper;
using Microsoft.Data.SqlClient;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.StockCount;

/// <summary>
/// Stock Count approval + Gains/Losses reporting — the slice of
/// routes/stockcount.js + routes/stockcountsql.js that Finance's own Stock
/// Adjustments tile actually needs. See StockCountModels.cs's header
/// comment for the full scope note (count creation/line entry/bin
/// completion/Finished Goods scanning/discrepancy resolution are real,
/// unbuilt scope deferred to Phase 7/Warehouse).
/// </summary>
internal static class StockCountHelper
{
    // Legacy code, already tile-scoped in Node (gates exactly this
    // approve/reject/report surface) — no split/default-group migration
    // needed, unlike Engineering/Quality/Sales's coarser legacy codes.
    internal const string FnStockApprove = "FIN_STOCK_APPROVE";

    internal static async Task<IReadOnlyList<StockCountDocumentRow>> ListCountsAsync(INexusOperationsDb db, string? status, CancellationToken ct)
    {
        const string sql = """
            SELECT CountId, CountType, StorageLocation, Status, WeekStartDate, CreatedBy, CreatedAtUtc,
                   SubmittedBy, SubmittedAtUtc, ApprovedBy, ApprovedAtUtc, RejectedBy, RejectedAtUtc, RejectionReason, PostedAtUtc
            FROM log.StockCountDocument
            WHERE (@status IS NULL OR Status = @status)
            ORDER BY CreatedAtUtc DESC
            """;

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<StockCountDocumentRow>(new CommandDefinition(sql, new { status }, cancellationToken: ct));
        return rows.ToArray();
    }

    /// <summary>
    /// Material-grouped report only (Node's groupBy=bin variant is
    /// Warehouse-side scope, deferred — see StockCountModels.cs). SapQty is
    /// derived as CountedQty - VarianceQty rather than summed directly from
    /// the raw per-line SapQty column: a material can span several
    /// (StorageType, Bin) groups, each independently folded so only one
    /// line per group carries a live, non-zeroed VarianceQty/VarianceValue
    /// (see the group-variance-folding logic this report depends on,
    /// documented in dotnet/CLAUDE.md's Phase 5 notes) — CountedQty and
    /// VarianceQty both sum correctly across groups by construction, so
    /// deriving SapQty from their difference avoids double-counting a raw
    /// per-line SapQty that was only ever meaningful within its own group.
    /// </summary>
    internal static async Task<IReadOnlyList<CountReportRow>> GetCountReportAsync(INexusOperationsDb db, int countId, string groupBy, CancellationToken ct)
    {
        if (!string.Equals(groupBy, "material", StringComparison.OrdinalIgnoreCase))
        {
            throw new NexusValidationException("Only groupBy=material is supported in this migration — bin-level grouping is Warehouse-side scope, deferred to Phase 7.");
        }

        const string sql = """
            SELECT Material, MAX(MaterialText) AS MaterialText, MAX(Uom) AS Uom,
                   SUM(CountedQty) AS CountedQty, SUM(VarianceQty) AS VarianceQty, SUM(VarianceValue) AS VarianceValue
            FROM log.StockCountLine
            WHERE CountId = @countId AND IsInvalidMaterial = 0
            GROUP BY Material
            ORDER BY Material
            """;

        using var connection = await db.CreateConnectionAsync(ct);
        var raw = await connection.QueryAsync<(string Material, string? MaterialText, string? Uom, decimal CountedQty, decimal? VarianceQty, decimal? VarianceValue)>(
            new CommandDefinition(sql, new { countId }, cancellationToken: ct));

        return raw.Select(r => new CountReportRow(
            r.Material, r.MaterialText, r.Uom, r.CountedQty,
            SapQty: r.CountedQty - (r.VarianceQty ?? 0),
            VarianceQty: r.VarianceQty, VarianceValue: r.VarianceValue)).ToArray();
    }

    // ── Weekly PTFE Cycle Count ─────────────────────────────────────────
    // Port of routes/stockcount.js's mostRecentMonday/getOrCreatePtfeCountForWeek
    // orchestration + GET /counts/current-ptfe — the last of the three
    // cron-backed features Phase 10 Slice 1 flagged as missing. Node treats
    // the Monday 05:56 cron (server.js's checkWeeklyPtfeCycleCountDue) as a
    // convenience pre-warm only; GET /counts/current-ptfe's lazy
    // getOrCreatePtfeCountForWeek call is the actual source of truth, so a
    // missed cron tick self-heals the moment anyone opens the tile — both
    // paths call the same GetOrCreatePtfeCountForWeekAsync below.

    /// <summary>This week's Monday, date-only (UTC) — matches WeekStartDate's DATE column. Direct port of Node's mostRecentMonday: (dayOfWeek + 6) % 7 days back from `now`, where Sunday=0.</summary>
    internal static DateTime MostRecentMonday(DateTime now)
    {
        var today = now.Date;
        var diffToMonday = ((int)today.DayOfWeek + 6) % 7;
        return today.AddDays(-diffToMonday);
    }

    internal sealed record PtfeCountCreationResult(int CountId, bool Created);

    /// <summary>Node's checkWeeklyPtfeCycleCountDue — the cron entry point. createdBy/createdByUserId are always null here, matching Node's cron call exactly (a scheduled job has no real portal-user context).</summary>
    internal static Task<PtfeCountCreationResult> CheckWeeklyPtfeCycleCountDueAsync(INexusOperationsDb db, CancellationToken ct) =>
        GetOrCreatePtfeCountForWeekAsync(db, MostRecentMonday(DateTime.UtcNow), createdBy: null, createdByUserId: null, ct);

    /// <summary>GET /counts/current-ptfe — lazily creates this week's PTFE count if the cron hasn't fired yet (or was missed), then returns it with its lines. Registered ahead of any future GET /counts/{id} route, same reasoning as Node's own route-ordering comment (not applicable yet — no such route exists in this port).</summary>
    internal static async Task<CurrentPtfeCountResult> GetCurrentPtfeCountAsync(INexusOperationsDb db, CancellationToken ct)
    {
        var (countId, _) = await GetOrCreatePtfeCountForWeekAsync(db, MostRecentMonday(DateTime.UtcNow), createdBy: null, createdByUserId: null, ct);

        using var connection = await db.CreateConnectionAsync(ct);
        var doc = await connection.QuerySingleAsync<StockCountDocumentRow>(new CommandDefinition(
            "SELECT CountId, CountType, StorageLocation, Status, WeekStartDate, CreatedBy, CreatedAtUtc, SubmittedBy, SubmittedAtUtc, ApprovedBy, ApprovedAtUtc, RejectedBy, RejectedAtUtc, RejectionReason, PostedAtUtc FROM log.StockCountDocument WHERE CountId = @countId",
            new { countId }, cancellationToken: ct));
        var lines = await connection.QueryAsync<CountLineRow>(new CommandDefinition(
            "SELECT LineId, CountId, Material, MaterialText, Uom, NamedLocation, StorageType, Bin, TicketNumber, CountedQty, SapQty, VarianceQty, UnitPrice, VarianceValue, IsInvalidMaterial, IsBatchManaged, BinCompletedBy, BinCompletedAtUtc, EnteredBy, EnteredAtUtc, UpdatedAtUtc FROM log.StockCountLine WHERE CountId = @countId ORDER BY LineId",
            new { countId }, cancellationToken: ct));

        return new CurrentPtfeCountResult(doc, lines.ToArray());
    }

    /// <summary>
    /// Idempotent PTFE-week creation, matching Node's getOrCreatePtfeCountForWeek
    /// exactly: check-then-insert is only the common path — the real
    /// guarantee against a race between the cron and a near-simultaneous
    /// page load is the filtered unique index (UQ_StockCountDocument_PtfeWeek
    /// on WeekStartDate WHERE CountType = 'PTFE_WEEKLY'), caught here as a
    /// unique-violation and resolved by re-fetching whichever caller won.
    /// </summary>
    private static async Task<PtfeCountCreationResult> GetOrCreatePtfeCountForWeekAsync(INexusOperationsDb db, DateTime weekStartDate, string? createdBy, int? createdByUserId, CancellationToken ct)
    {
        var existing = await GetPtfeCountForWeekAsync(db, weekStartDate, ct);
        if (existing is not null)
        {
            return new PtfeCountCreationResult(existing.Value, false);
        }

        try
        {
            var countId = await CreateCountDocumentAsync(db, "PTFE_WEEKLY", storageLocation: null, weekStartDate, createdBy, createdByUserId, ct);
            return new PtfeCountCreationResult(countId, true);
        }
        catch (SqlException ex) when (ex.Number is 2627 or 2601)
        {
            var winner = await GetPtfeCountForWeekAsync(db, weekStartDate, ct);
            if (winner is not null)
            {
                return new PtfeCountCreationResult(winner.Value, false);
            }
            throw;
        }
    }

    private static async Task<int?> GetPtfeCountForWeekAsync(INexusOperationsDb db, DateTime weekStartDate, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleOrDefaultAsync<int?>(new CommandDefinition(
            "SELECT CountId FROM log.StockCountDocument WHERE CountType = 'PTFE_WEEKLY' AND WeekStartDate = @weekStartDate",
            new { weekStartDate }, cancellationToken: ct));
    }

    private static async Task<int> CreateCountDocumentAsync(INexusOperationsDb db, string countType, string? storageLocation, DateTime? weekStartDate, string? createdBy, int? createdByUserId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleAsync<int>(new CommandDefinition("""
            INSERT INTO log.StockCountDocument (CountType, StorageLocation, WeekStartDate, CreatedBy, CreatedByUserId, Status)
            OUTPUT INSERTED.CountId
            VALUES (@countType, @storageLocation, @weekStartDate, @createdBy, @createdByUserId, 'Open')
            """, new { countType, storageLocation, weekStartDate, createdBy, createdByUserId }, cancellationToken: ct));
    }

    private sealed record ApprovalLine(int LineId, string Material, string? StorageType, string? Bin, decimal VarianceQty, string? Uom);

    /// <summary>
    /// Posts one 711 (gain) or 712 (loss) SAP goods movement per non-zero-
    /// variance line, in parallel (matches Node's Promise.all, not
    /// sequential). Document status always moves to Approved regardless of
    /// per-line posting outcome; it only additionally moves to Posted if
    /// every posting succeeded (vacuously true when there's nothing to
    /// post). A partially-failed Approved-but-not-Posted count has no safe
    /// automated retry — re-running would double-post the lines that
    /// already succeeded, since there's no per-line PostedAtUtc column —
    /// this is a deliberately preserved Node limitation, not an oversight;
    /// see dotnet/CLAUDE.md's Phase 5 notes.
    /// </summary>
    internal static async Task<ApproveCountResult> ApproveAsync(INexusOperationsDb db, ISapServerClient sap, int countId, string? username, int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var status = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "SELECT Status FROM log.StockCountDocument WHERE CountId = @countId", new { countId }, cancellationToken: ct));
        if (status is null)
        {
            throw new NexusNotFoundException($"Stock count {countId} not found.");
        }
        if (status != "PendingApproval")
        {
            throw new NexusValidationException($"Stock count {countId} is not pending approval (status: {status}).");
        }

        var storageLocation = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "SELECT StorageLocation FROM log.StockCountDocument WHERE CountId = @countId", new { countId }, cancellationToken: ct));

        var lines = (await connection.QueryAsync<ApprovalLine>(new CommandDefinition("""
            SELECT LineId, Material, StorageType, Bin, VarianceQty, Uom
            FROM log.StockCountLine
            WHERE CountId = @countId AND IsInvalidMaterial = 0 AND VarianceQty IS NOT NULL AND VarianceQty <> 0
            """, new { countId }, cancellationToken: ct))).ToList();

        var postTasks = lines.Select(line => PostOneAdjustmentAsync(sap, countId, storageLocation, line, userId, ct));
        var results = await Task.WhenAll(postTasks);

        var allSucceeded = results.Length == 0 || results.All(r => r.Success);
        var postedLineCount = results.Count(r => r.Success);

        await connection.ExecuteAsync(new CommandDefinition(
            "UPDATE log.StockCountDocument SET Status = 'Approved', ApprovedBy = @username, ApprovedAtUtc = GETUTCDATE() WHERE CountId = @countId",
            new { username, countId }, cancellationToken: ct));

        if (allSucceeded)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "UPDATE log.StockCountDocument SET Status = 'Posted', PostedByUserId = @userId, PostedAtUtc = GETUTCDATE() WHERE CountId = @countId",
                new { userId, countId }, cancellationToken: ct));
        }

        return new ApproveCountResult(results.ToList(), allSucceeded, postedLineCount);
    }

    private static async Task<ApproveResultLine> PostOneAdjustmentAsync(ISapServerClient sap, int countId, string? storageLocation, ApprovalLine line, int userId, CancellationToken ct)
    {
        var request = new StockAdjustmentRequest(
            Material: line.Material,
            StorageLocation: storageLocation ?? "",
            StorageType: line.StorageType ?? "SA",
            StorageBin: line.Bin ?? "PTFE",
            MovementType: line.VarianceQty > 0 ? "711" : "712",
            Quantity: Math.Abs(line.VarianceQty),
            Unit: line.Uom ?? "",
            Reference: $"StockCount{countId}");

        try
        {
            var response = await sap.PostAsync<StockAdjustmentResponse>("api/warehouse/stock-adjustment", request, userId, ct: ct);
            return new ApproveResultLine(line.Material, line.StorageType, line.Bin, response?.Success ?? false, response?.Success == true ? null : "SAP did not confirm success.", response?.MaterialDocument);
        }
        catch (Exception ex)
        {
            return new ApproveResultLine(line.Material, line.StorageType, line.Bin, false, ex.Message, null);
        }
    }

    internal static async Task RejectAsync(INexusOperationsDb db, int countId, RejectCountRequest body, string? username, CancellationToken ct)
    {
        var reason = body.Reason?.Trim();
        if (string.IsNullOrWhiteSpace(reason))
        {
            throw new NexusValidationException("reason is required.");
        }

        using var connection = await db.CreateConnectionAsync(ct);
        var status = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "SELECT Status FROM log.StockCountDocument WHERE CountId = @countId", new { countId }, cancellationToken: ct));
        if (status is null)
        {
            throw new NexusNotFoundException($"Stock count {countId} not found.");
        }
        if (status != "PendingApproval")
        {
            throw new NexusValidationException($"Stock count {countId} is not pending approval (status: {status}).");
        }

        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.StockCountDocument
            SET Status = 'Rejected', RejectedBy = @username, RejectedAtUtc = GETUTCDATE(), RejectionReason = @reason
            WHERE CountId = @countId
            """, new { username, reason, countId }, cancellationToken: ct));
    }

    /// <summary>
    /// Historical gain/loss report across every count that reached
    /// Approved/Posted (Rejected excluded) — backs Finance's "View
    /// Gains/Losses Report" screen. Date range applies to the decided date
    /// (ApprovedAtUtc, falling back to CreatedAtUtc for older data) — the
    /// exact Node default when from/to are omitted is unconfirmed, so this
    /// port defaults to a wide all-time range rather than guessing a
    /// specific window.
    /// </summary>
    internal static async Task<FinanceReportResult> GetFinanceReportAsync(INexusOperationsDb db, DateTime? from, DateTime? to, CancellationToken ct)
    {
        var fromDate = from ?? new DateTime(1900, 1, 1);
        var toDate = to ?? DateTime.UtcNow.Date;

        using var connection = await db.CreateConnectionAsync(ct);

        var totals = await connection.QuerySingleAsync<(decimal Gains, decimal Losses)>(new CommandDefinition("""
            SELECT
                SUM(CASE WHEN l.VarianceValue > 0 THEN l.VarianceValue ELSE 0 END) AS Gains,
                SUM(CASE WHEN l.VarianceValue < 0 THEN l.VarianceValue ELSE 0 END) AS Losses
            FROM log.StockCountLine l
            JOIN log.StockCountDocument d ON d.CountId = l.CountId
            WHERE d.Status IN ('Approved', 'Posted')
              AND CAST(COALESCE(d.ApprovedAtUtc, d.CreatedAtUtc) AS DATE) BETWEEN @fromDate AND @toDate
            """, new { fromDate, toDate }, cancellationToken: ct));

        var byMaterial = (await connection.QueryAsync<FinanceReportOffenderRow>(new CommandDefinition("""
            SELECT TOP 20 l.Material AS [Key], SUM(l.VarianceValue) AS NetValue
            FROM log.StockCountLine l
            JOIN log.StockCountDocument d ON d.CountId = l.CountId
            WHERE d.Status IN ('Approved', 'Posted')
              AND CAST(COALESCE(d.ApprovedAtUtc, d.CreatedAtUtc) AS DATE) BETWEEN @fromDate AND @toDate
            GROUP BY l.Material
            ORDER BY ABS(SUM(l.VarianceValue)) DESC
            """, new { fromDate, toDate }, cancellationToken: ct))).ToList();

        var byBin = (await connection.QueryAsync<FinanceReportOffenderRow>(new CommandDefinition("""
            SELECT TOP 20 (l.StorageType + '/' + l.Bin) AS [Key], SUM(l.VarianceValue) AS NetValue
            FROM log.StockCountLine l
            JOIN log.StockCountDocument d ON d.CountId = l.CountId
            WHERE d.Status IN ('Approved', 'Posted') AND l.Bin IS NOT NULL AND l.StorageType IS NOT NULL
              AND CAST(COALESCE(d.ApprovedAtUtc, d.CreatedAtUtc) AS DATE) BETWEEN @fromDate AND @toDate
            GROUP BY l.StorageType, l.Bin
            ORDER BY ABS(SUM(l.VarianceValue)) DESC
            """, new { fromDate, toDate }, cancellationToken: ct))).ToList();

        var counts = (await connection.QueryAsync<FinanceReportCountRow>(new CommandDefinition("""
            SELECT d.CountId, d.CountType, d.StorageLocation, d.Status,
                   COALESCE(d.ApprovedAtUtc, d.CreatedAtUtc) AS DecidedAtUtc,
                   COALESCE((SELECT SUM(l.VarianceValue) FROM log.StockCountLine l WHERE l.CountId = d.CountId), 0) AS NetValue
            FROM log.StockCountDocument d
            WHERE d.Status IN ('Approved', 'Posted')
              AND CAST(COALESCE(d.ApprovedAtUtc, d.CreatedAtUtc) AS DATE) BETWEEN @fromDate AND @toDate
            ORDER BY DecidedAtUtc DESC
            """, new { fromDate, toDate }, cancellationToken: ct))).ToList();

        var gains = totals.Gains;
        var losses = totals.Losses;
        return new FinanceReportResult(gains, losses, gains + losses, byMaterial, byBin, counts);
    }
}
