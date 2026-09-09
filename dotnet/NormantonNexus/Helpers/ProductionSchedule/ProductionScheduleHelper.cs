using Dapper;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.ProductionSchedule;

/// <summary>
/// Production Schedule — shared between Sales and Production department
/// pages. Port of routes/productionschedule.js + routes/productionschedulesql.js.
///
/// Schema note (flagged by research, not independently confirmed against a
/// live database in this sandbox): the SQL migration *comments* for this
/// feature reference a dbo schema, but the actual Node route/DB-layer code
/// queries log.AgreementSnapshot / prod.ProductionScheduleComments /
/// log.OrderFulfillmentTracking (schema-qualified) — most likely the tables
/// were moved to log/prod out-of-band and the migration comments are stale.
/// This port uses the schema-qualified names from the real querying code
/// (the actual source of truth for a live database), matching the same
/// log/prod convention Engineering/Quality's own queries already used.
/// Confirm against the real NexusOperations database before trusting this
/// in production.
/// </summary>
internal static class ProductionScheduleHelper
{
    // Replaces Node's "PROD_SUPERVISOR OR SALES_SUPERVISOR" requireAnyPermission
    // gate on the comment/ETA save action with one new per-tile code — see the
    // migration for how holders of either legacy code keep access via a
    // shared default group. View access stays the "production OR sales"
    // department gate (Dept:production,sales), unchanged in shape.
    internal const string FnScheduleEdit = "PROD_SCHEDULE_EDIT";

    private const int ScheduleOffsetWorkingDays = 2;
    private const int ScheduleWindowWorkingDays = 5;

    private static DateTime AddWorkingDaysUtc(DateTime date, int days)
    {
        var result = date;
        var step = days >= 0 ? 1 : -1;
        var remaining = Math.Abs(days);
        while (remaining > 0)
        {
            result = result.AddDays(step);
            if (result.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday))
            {
                remaining--;
            }
        }
        return result;
    }

    private sealed record CommentRow(string ReferenceDocument, string Item, string? Comment, DateTime? Eta, DateTime? LastUpdatedUtc, string? UpdatedByUsername);

    private static async Task<Dictionary<(string, string), CommentRow>> ListCommentsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        const string sql = """
            SELECT ReferenceDocument, Item, Comment, Eta, LastUpdatedUtc, UpdatedByUsername
            FROM prod.ProductionScheduleComments
            """;

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<CommentRow>(new CommandDefinition(sql, cancellationToken: ct));
        return rows.ToDictionary(r => (r.ReferenceDocument, r.Item));
    }

    private sealed record AgreementSnapshotRow(
        string Customer, string CustomerName, string ReferenceDocument, string Item, string Material, string MaterialText,
        DateTime? RequestDate, decimal OrderQty, string Uom, decimal StockQty, decimal PickedQty,
        decimal? StandardPrice, decimal? Amount, string? Currency);

    private const string AgreementSnapshotColumns = """
        Customer, CustomerName, OriginalDoc AS ReferenceDocument, OriginalDocItem AS Item, Material, MaterialText,
        CAST(CONVERT(VARCHAR(8), RequestDate, 112) AS DATETIME) AS RequestDate,
        OrderQty, Uom,
        DockStockAllocated   AS StockQty,
        PickedStockAllocated AS PickedQty,
        StandardPrice, Amount, Currency
        """;

    internal static async Task<ProductionScheduleListResponse> GetProductionScheduleAsync(INexusOperationsDb db, CancellationToken ct)
    {
        var today = DateTime.UtcNow.Date;
        var windowStart = AddWorkingDaysUtc(today, ScheduleOffsetWorkingDays);
        var windowEnd = AddWorkingDaysUtc(windowStart, ScheduleWindowWorkingDays - 1);

        var sql = $"""
            SELECT {AgreementSnapshotColumns}
            FROM log.AgreementSnapshot
            WHERE RequestDate IS NOT NULL
              AND ValueStream = 'PTFE'
              AND CONVERT(VARCHAR(8), RequestDate, 112) >= CONVERT(VARCHAR(8), @start, 112)
              AND CONVERT(VARCHAR(8), RequestDate, 112) <= CONVERT(VARCHAR(8), @end, 112)
            ORDER BY RequestDate, CustomerName, ReferenceDocument, Item
            """;

        using var connection = await db.CreateConnectionAsync(ct);
        var rawRows = await connection.QueryAsync<AgreementSnapshotRow>(new CommandDefinition(sql, new { start = windowStart, end = windowEnd }, cancellationToken: ct));
        var comments = await ListCommentsAsync(db, ct);

        var rows = rawRows.Select(r =>
        {
            comments.TryGetValue((r.ReferenceDocument, r.Item), out var comment);

            return new ProductionScheduleRow(
                r.Customer, r.CustomerName, r.ReferenceDocument, r.Item, r.Material, r.MaterialText,
                r.RequestDate, r.OrderQty, r.Uom, r.StockQty, r.PickedQty, r.StandardPrice, r.Amount, r.Currency,
                DisplayDate: r.RequestDate is { } rd ? AddWorkingDaysUtc(rd, -ScheduleOffsetWorkingDays) : null,
                Comment: comment?.Comment ?? "", Eta: comment?.Eta,
                CommentUpdatedUtc: comment?.LastUpdatedUtc, CommentUpdatedBy: comment?.UpdatedByUsername);
        }).ToList();

        return new ProductionScheduleListResponse(rows, windowStart, windowEnd);
    }

    internal static async Task<IReadOnlyList<ProductionArrearsRow>> GetProductionArrearsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        var today = DateTime.UtcNow.Date;

        var sql = $"""
            SELECT {AgreementSnapshotColumns}
            FROM log.AgreementSnapshot
            WHERE RequestDate IS NOT NULL
              AND ValueStream = 'PTFE'
              AND CONVERT(VARCHAR(8), RequestDate, 112) < CONVERT(VARCHAR(8), @today, 112)
            ORDER BY RequestDate, CustomerName, ReferenceDocument, Item
            """;

        using var connection = await db.CreateConnectionAsync(ct);
        var rawRows = await connection.QueryAsync<AgreementSnapshotRow>(new CommandDefinition(sql, new { today }, cancellationToken: ct));
        var comments = await ListCommentsAsync(db, ct);

        return rawRows.Select(r =>
        {
            comments.TryGetValue((r.ReferenceDocument, r.Item), out var comment);

            return new ProductionArrearsRow(
                r.Customer, r.CustomerName, r.ReferenceDocument, r.Item, r.Material, r.MaterialText,
                r.RequestDate, r.OrderQty, r.Uom, r.StockQty, r.PickedQty, r.StandardPrice, r.Amount, r.Currency,
                Comment: comment?.Comment ?? "", Eta: comment?.Eta,
                CommentUpdatedUtc: comment?.LastUpdatedUtc, CommentUpdatedBy: comment?.UpdatedByUsername);
        }).ToArray();
    }

    internal static async Task UpsertCommentAsync(
        INexusOperationsDb db, string referenceDocument, string item, ProductionScheduleCommentSaveRequest body, string? username, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var exists = await connection.QuerySingleOrDefaultAsync<int?>(new CommandDefinition(
            "SELECT 1 FROM prod.ProductionScheduleComments WHERE ReferenceDocument = @referenceDocument AND Item = @item",
            new { referenceDocument, item }, cancellationToken: ct)) is not null;

        if (exists)
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE prod.ProductionScheduleComments
                SET Comment = @comment, Eta = @eta, LastUpdatedUtc = GETUTCDATE(), UpdatedByUsername = @username
                WHERE ReferenceDocument = @referenceDocument AND Item = @item
                """, new { referenceDocument, item, comment = body.Comment, eta = body.Eta, username }, cancellationToken: ct));
        }
        else
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO prod.ProductionScheduleComments (ReferenceDocument, Item, Comment, Eta, LastUpdatedUtc, UpdatedByUsername)
                VALUES (@referenceDocument, @item, @comment, @eta, GETUTCDATE(), @username)
                """, new { referenceDocument, item, comment = body.Comment, eta = body.Eta, username }, cancellationToken: ct));
        }
    }

    internal static async Task<IReadOnlyList<OtifKpiRow>> GetOtifKpiHistoryAsync(INexusOperationsDb db, CancellationToken ct)
    {
        const string sql = """
            SELECT DATEPART(YEAR, CompletedDate) AS Year, DATEPART(MONTH, CompletedDate) AS Month,
                   SUM(CASE WHEN OnTime = 1 THEN 1 ELSE 0 END) AS OnTimeCount, COUNT(*) AS TotalCount
            FROM log.OrderFulfillmentTracking
            WHERE Status = 'COMPLETED' AND CompletedDate IS NOT NULL
            GROUP BY DATEPART(YEAR, CompletedDate), DATEPART(MONTH, CompletedDate)
            ORDER BY Year, Month
            """;

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<(int Year, int Month, int OnTimeCount, int TotalCount)>(new CommandDefinition(sql, cancellationToken: ct));
        return rows.Select(r => new OtifKpiRow(r.Year, r.Month, r.OnTimeCount, r.TotalCount,
            r.TotalCount > 0 ? (double)r.OnTimeCount / r.TotalCount * 100 : null)).ToArray();
    }

    internal static async Task<IReadOnlyList<OtifLateRow>> GetOtifLateListAsync(INexusOperationsDb db, CancellationToken ct)
    {
        const string sql = """
            SELECT TOP 200 ReferenceDocument, Item, Customer, CustomerName, Material, MaterialText,
                   OrderQty, Uom, DueDate, CompletedDate, Reason
            FROM log.OrderFulfillmentTracking
            WHERE Status = 'COMPLETED' AND OnTime = 0
            ORDER BY CompletedDate DESC
            """;

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<OtifLateRow>(new CommandDefinition(sql, cancellationToken: ct));
        return rows.ToArray();
    }

    private sealed record OpenAgreementKey(string ReferenceDocument, string Item, string Customer, string CustomerName,
        string Material, string MaterialText, string ValueStream, decimal OrderQty, string Uom, DateTime? RequestDate);

    private sealed record TrackedRow(int TrackingId, string ReferenceDocument, string Item, DateTime? DueDate);

    /// <summary>
    /// Daily reconciliation between currently-open PTFE agreement lines and
    /// the OrderFulfillmentTracking table — port of productionschedulesql.js's
    /// diffProductionScheduleOtif(). Not yet wired to a scheduled trigger
    /// (Node runs it daily at 06:10 via node-cron) — this app has no
    /// background-job infrastructure until Phase 10 (Quartz.NET). Callable
    /// now so Phase 10 only needs to add the trigger, not write this logic.
    /// </summary>
    internal static async Task<OtifDiffResult> DiffProductionScheduleOtifAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var openSql = """
            SELECT OriginalDoc AS ReferenceDocument, OriginalDocItem AS Item, Customer, CustomerName,
                   Material, MaterialText, ValueStream, OrderQty, Uom,
                   CAST(CONVERT(VARCHAR(8), RequestDate, 112) AS DATETIME) AS RequestDate
            FROM log.AgreementSnapshot
            WHERE RequestDate IS NOT NULL AND ValueStream = 'PTFE'
            """;
        var openRows = (await connection.QueryAsync<OpenAgreementKey>(new CommandDefinition(openSql, cancellationToken: ct))).ToList();
        var openKeys = openRows.Select(r => (r.ReferenceDocument, r.Item)).ToHashSet();

        var trackedSql = "SELECT TrackingID AS TrackingId, ReferenceDocument, Item, DueDate FROM log.OrderFulfillmentTracking WHERE Status = 'OPEN'";
        var trackedRows = (await connection.QueryAsync<TrackedRow>(new CommandDefinition(trackedSql, cancellationToken: ct))).ToList();
        var trackedMap = trackedRows.ToDictionary(r => (r.ReferenceDocument, r.Item));

        var inserted = 0;
        foreach (var row in openRows)
        {
            if (trackedMap.ContainsKey((row.ReferenceDocument, row.Item))) continue;

            await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO log.OrderFulfillmentTracking
                    (ReferenceDocument, Item, Customer, CustomerName, Material, MaterialText, ValueStream, OrderQty, Uom, DueDate, Status, FirstSeenUtc, LastSeenUtc)
                VALUES
                    (@ReferenceDocument, @Item, @Customer, @CustomerName, @Material, @MaterialText, @ValueStream, @OrderQty, @Uom, @RequestDate, 'OPEN', GETUTCDATE(), GETUTCDATE())
                """, row, cancellationToken: ct));
            inserted++;
        }

        var refreshed = 0;
        foreach (var row in openRows)
        {
            if (!trackedMap.TryGetValue((row.ReferenceDocument, row.Item), out var tracked)) continue;

            await connection.ExecuteAsync(new CommandDefinition(
                "UPDATE log.OrderFulfillmentTracking SET LastSeenUtc = GETUTCDATE(), DueDate = @due WHERE TrackingID = @id",
                new { due = row.RequestDate, id = tracked.TrackingId }, cancellationToken: ct));
            refreshed++;
        }

        var completed = 0;
        var today = DateTime.UtcNow.Date;
        foreach (var tracked in trackedRows)
        {
            if (openKeys.Contains((tracked.ReferenceDocument, tracked.Item))) continue;

            bool? onTime = tracked.DueDate is { } due ? today <= due : null;
            string? reason = null;
            if (onTime == false)
            {
                reason = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
                    "SELECT Comment FROM prod.ProductionScheduleComments WHERE ReferenceDocument = @ref AND Item = @item",
                    new { @ref = tracked.ReferenceDocument, item = tracked.Item }, cancellationToken: ct));
            }

            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE log.OrderFulfillmentTracking
                SET Status = 'COMPLETED', CompletedDate = @completedDate, OnTime = @onTime, Reason = @reason
                WHERE TrackingID = @id
                """, new { completedDate = today, onTime, reason, id = tracked.TrackingId }, cancellationToken: ct));
            completed++;
        }

        return new OtifDiffResult(inserted, refreshed, completed);
    }
}
