using Dapper;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Production;

/// <summary>
/// The 7 Production supervisor reports — port of the "Report N" blocks in
/// routes/productionnexus.js (lines ~357-546). All 7 share RPT_COMPLETED/
/// RPT_ALL_STATUSES (a UNION ALL across every metre-process + Drumming
/// table) and the day/week/month period-grouping expression — ported
/// verbatim below, including which reports do and don't apply the
/// process/material filter (Node's own queries are inconsistent about
/// this — SAP Performance and Scrap deliberately don't filter by
/// process/material even though the query params exist, matching the
/// real Node behavior rather than "fixing" an apparent inconsistency).
/// </summary>
internal static class ProductionReportsHelper
{
    // Existing legacy code, not split — gates the widest tile spread of any
    // code in this migration (26 routes across ~8 tiles per research). A
    // genuine per-tile split (PROD_REPORTS_VIEW, PROD_REVERSAL, etc.) is a
    // deliberate, deferred design decision — see dotnet/CLAUDE.md's Phase 6
    // notes — not something to guess at ahead of the tiles it would gate
    // actually existing.
    internal const string FnSupervisor = "PROD_SUPERVISOR";

    private const string RptCompleted = """
        SELECT N'MX' AS ProcessCode, N'KG' AS UOM, TotalWeightKG AS Quantity, ShiftID, CompletedAt, Material FROM prod.Mixing WHERE Status=4 AND IsReversed=0
        UNION ALL SELECT N'EX', N'M', LengthMetres, ShiftID, CompletedAt, Material FROM prod.Extrusion WHERE Status=4 AND IsReversed=0
        UNION ALL SELECT N'CO', N'M', LengthMetres, ShiftID, CompletedAt, Material FROM prod.Convoluting WHERE Status=4 AND IsReversed=0
        UNION ALL SELECT N'BR', N'M', LengthMetres, ShiftID, CompletedAt, Material FROM prod.Braiding WHERE Status=4 AND IsReversed=0
        UNION ALL SELECT N'CL', N'M', LengthMetres, ShiftID, CompletedAt, Material FROM prod.Coverline WHERE Status=4 AND IsReversed=0
        UNION ALL SELECT N'TW', N'M', LengthMetres, ShiftID, CompletedAt, Material FROM prod.TapeWrap WHERE Status=4 AND IsReversed=0
        UNION ALL SELECT N'DR', N'M', LengthMetres, ShiftID, CompletedAt, Material FROM prod.Drumming WHERE Status=4 AND IsReversed=0
        """;

    private const string RptAllStatuses = """
        SELECT N'MX' AS ProcessCode, Status, IsReversed, ShiftID, CompletedAt FROM prod.Mixing
        UNION ALL SELECT N'EX', Status, IsReversed, ShiftID, CompletedAt FROM prod.Extrusion
        UNION ALL SELECT N'CO', Status, IsReversed, ShiftID, CompletedAt FROM prod.Convoluting
        UNION ALL SELECT N'BR', Status, IsReversed, ShiftID, CompletedAt FROM prod.Braiding
        UNION ALL SELECT N'CL', Status, IsReversed, ShiftID, CompletedAt FROM prod.Coverline
        UNION ALL SELECT N'TW', Status, IsReversed, ShiftID, CompletedAt FROM prod.TapeWrap
        UNION ALL SELECT N'DR', Status, IsReversed, ShiftID, CompletedAt FROM prod.Drumming
        """;

    private static string Period(string col, string groupBy) => groupBy switch
    {
        "month" => $"CAST(DATEPART(year,{col}) AS varchar(4)) + N'-' + RIGHT(N'0'+CAST(DATEPART(month,{col}) AS varchar(2)),2)",
        "week" => $"CAST(DATEPART(year,{col}) AS varchar(4)) + N'-W' + RIGHT(N'0'+CAST(DATEPART(week,{col}) AS varchar(2)),2)",
        _ => $"CONVERT(varchar(10),{col},120)",
    };

    private static (DateTime From, DateTime To, string GroupBy) Bind(ReportFilterQuery q)
    {
        var from = DateTime.TryParse(q.DateFrom, out var f) ? f : DateTime.UtcNow.AddDays(-30);
        // Date-only strings parse as midnight — extend "to" to end-of-day so
        // records posted any time on the selected day are included, matching
        // Node's dateTo + 'T23:59:59' handling.
        var to = DateTime.TryParse(q.DateTo, out var t) ? t.Date.AddDays(1).AddSeconds(-1) : DateTime.UtcNow;
        var groupBy = q.GroupBy is "day" or "week" or "month" ? q.GroupBy : "day";
        return (from, to, groupBy);
    }

    internal static async Task<ReportOutputResult> GetOutputAsync(INexusOperationsDb db, ReportFilterQuery query, CancellationToken ct)
    {
        var (from, to, groupBy) = Bind(query);
        var period = Period("CompletedAt", groupBy);
        var pc = query.ProcessCode?.ToUpperInvariant();

        using var connection = await db.CreateConnectionAsync(ct);

        var summary = await connection.QueryAsync<ReportOutputSummaryRow>(new CommandDefinition($"""
            SELECT ProcessCode, UOM, COUNT(*) AS BatchCount,
                   CAST(SUM(Quantity) AS DECIMAL(14,3)) AS TotalOutput,
                   CAST(SUM(Quantity)/COUNT(*) AS DECIMAL(14,3)) AS AvgPerBatch
            FROM ({RptCompleted}) AS B
            WHERE CompletedAt BETWEEN @from AND @to
            GROUP BY ProcessCode, UOM ORDER BY ProcessCode
            """, new { from, to }, cancellationToken: ct));

        var timeSeries = await connection.QueryAsync<ReportOutputSeriesRow>(new CommandDefinition($"""
            SELECT ProcessCode, UOM, {period} AS Period, COUNT(*) AS BatchCount,
                   CAST(SUM(Quantity) AS DECIMAL(14,3)) AS TotalOutput
            FROM ({RptCompleted}) AS B
            WHERE CompletedAt BETWEEN @from AND @to AND (@pc IS NULL OR ProcessCode = @pc)
            GROUP BY ProcessCode, UOM, {period} ORDER BY Period, ProcessCode
            """, new { from, to, pc }, cancellationToken: ct));

        return new ReportOutputResult(summary.ToList(), timeSeries.ToList());
    }

    internal static async Task<ReportScrapResult> GetScrapAsync(INexusOperationsDb db, ReportFilterQuery query, CancellationToken ct)
    {
        var (from, to, groupBy) = Bind(query);
        var period = Period("se.EnteredAt", groupBy);

        using var connection = await db.CreateConnectionAsync(ct);

        var byReason = (await connection.QueryAsync<ReportScrapByReasonRow>(new CommandDefinition("""
            SELECT sr.ReasonCode, sr.ReasonDescription, SUM(se.Quantity) AS TotalKg, COUNT(*) AS EntryCount
            FROM prod.ScrapEntries se JOIN prod.ScrapReasons sr ON sr.ReasonID = se.ReasonID
            WHERE se.EnteredAt BETWEEN @from AND @to
            GROUP BY sr.ReasonCode, sr.ReasonDescription ORDER BY TotalKg DESC
            """, new { from, to }, cancellationToken: ct))).ToList();

        var byProcess = await connection.QueryAsync<ReportScrapByProcessRow>(new CommandDefinition("""
            SELECT se.ProcessCode, SUM(se.Quantity) AS TotalKg, COUNT(*) AS EntryCount
            FROM prod.ScrapEntries se
            WHERE se.EnteredAt BETWEEN @from AND @to
            GROUP BY se.ProcessCode ORDER BY TotalKg DESC
            """, new { from, to }, cancellationToken: ct));

        var timeSeries = await connection.QueryAsync<ReportScrapSeriesRow>(new CommandDefinition($"""
            SELECT {period} AS Period, CAST(SUM(se.Quantity) AS DECIMAL(14,3)) AS TotalKg, COUNT(*) AS EntryCount
            FROM prod.ScrapEntries se
            WHERE se.EnteredAt BETWEEN @from AND @to
            GROUP BY {period} ORDER BY Period
            """, new { from, to }, cancellationToken: ct));

        var totalKg = byReason.Sum(r => r.TotalKg);
        var entryCount = byReason.Sum(r => r.EntryCount);
        var topReason = byReason.Count > 0 ? byReason[0].ReasonDescription : "—";

        return new ReportScrapResult(new ReportScrapTotals(totalKg, entryCount, topReason), byReason, byProcess.ToList(), timeSeries.ToList());
    }

    internal static async Task<ReportSapPerfResult> GetSapPerformanceAsync(INexusOperationsDb db, ReportFilterQuery query, CancellationToken ct)
    {
        var (from, to, groupBy) = Bind(query);
        var period = Period("sp.PostedAt", groupBy);

        using var connection = await db.CreateConnectionAsync(ct);

        var byProcess = await connection.QueryAsync<ReportSapPerfByProcessRow>(new CommandDefinition("""
            SELECT ProcessCode, COUNT(*) AS Total,
                   SUM(CASE WHEN IsSuccess=1 AND IsReversed=0 THEN 1 ELSE 0 END) AS Success,
                   SUM(CASE WHEN IsSuccess=0 THEN 1 ELSE 0 END) AS Failed,
                   SUM(CASE WHEN IsSuccess=1 AND IsReversed=1 THEN 1 ELSE 0 END) AS Reversed
            FROM prod.SAPPostings sp
            WHERE PostingType=N'BACKFLUSH' AND PostedAt BETWEEN @from AND @to
            GROUP BY ProcessCode ORDER BY ProcessCode
            """, new { from, to }, cancellationToken: ct));

        var timeSeries = await connection.QueryAsync<ReportSapPerfSeriesRow>(new CommandDefinition($"""
            SELECT {period} AS Period,
                   SUM(CASE WHEN IsSuccess=1 THEN 1 ELSE 0 END) AS Success,
                   SUM(CASE WHEN IsSuccess=0 THEN 1 ELSE 0 END) AS Failed
            FROM prod.SAPPostings sp
            WHERE PostingType=N'BACKFLUSH' AND sp.PostedAt BETWEEN @from AND @to
            GROUP BY {period} ORDER BY Period
            """, new { from, to }, cancellationToken: ct));

        var alerts = await connection.QueryAsync<ReportSapPerfAlertRow>(new CommandDefinition("""
            SELECT ProcessCode, COUNT(*) AS AlertCount FROM prod.BackflushAlerts
            WHERE CreatedAt BETWEEN @from AND @to GROUP BY ProcessCode
            """, new { from, to }, cancellationToken: ct));

        return new ReportSapPerfResult(byProcess.ToList(), timeSeries.ToList(), alerts.ToList());
    }

    internal static async Task<IReadOnlyList<ReportBatchStatusRow>> GetBatchesAsync(INexusOperationsDb db, ReportFilterQuery query, CancellationToken ct)
    {
        var (from, to, _) = Bind(query);
        var pc = query.ProcessCode?.ToUpperInvariant();

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ReportBatchStatusRow>(new CommandDefinition($"""
            SELECT ProcessCode,
                SUM(CASE WHEN IsReversed=1 THEN 1 ELSE 0 END) AS Reversed,
                SUM(CASE WHEN Status=4 AND IsReversed=0 THEN 1 ELSE 0 END) AS Complete,
                SUM(CASE WHEN Status=6 THEN 1 ELSE 0 END) AS SapFailed,
                SUM(CASE WHEN Status=5 THEN 1 ELSE 0 END) AS Cancelled,
                COUNT(*) AS Total
            FROM ({RptAllStatuses}) AS B
            WHERE CompletedAt BETWEEN @from AND @to AND (@pc IS NULL OR ProcessCode = @pc)
            GROUP BY ProcessCode ORDER BY ProcessCode
            """, new { from, to, pc }, cancellationToken: ct));
        return rows.ToArray();
    }

    internal static async Task<ReportShiftResult> GetShiftComparisonAsync(INexusOperationsDb db, ReportFilterQuery query, CancellationToken ct)
    {
        var (from, to, _) = Bind(query);
        var pc = query.ProcessCode?.ToUpperInvariant();

        using var connection = await db.CreateConnectionAsync(ct);

        var output = await connection.QueryAsync<ReportShiftOutputRow>(new CommandDefinition($"""
            SELECT s.ShiftName, B.ProcessCode, B.UOM, COUNT(*) AS BatchCount,
                   CAST(SUM(B.Quantity) AS DECIMAL(14,3)) AS TotalOutput
            FROM ({RptCompleted}) AS B
            JOIN prod.Shifts s ON s.ShiftID = B.ShiftID
            WHERE B.CompletedAt BETWEEN @from AND @to AND (@pc IS NULL OR B.ProcessCode = @pc)
            GROUP BY s.ShiftName, B.ProcessCode, B.UOM
            ORDER BY s.ShiftName, B.ProcessCode
            """, new { from, to, pc }, cancellationToken: ct));

        var scrap = await connection.QueryAsync<ReportShiftScrapRow>(new CommandDefinition("""
            SELECT se.ProcessCode, CAST(SUM(se.Quantity) AS DECIMAL(14,3)) AS ScrapKg, COUNT(*) AS EntryCount
            FROM prod.ScrapEntries se
            WHERE se.EnteredAt BETWEEN @from AND @to
            GROUP BY se.ProcessCode ORDER BY se.ProcessCode
            """, new { from, to }, cancellationToken: ct));

        return new ReportShiftResult(output.ToList(), scrap.ToList());
    }

    internal static async Task<IReadOnlyList<ReportOperatorOutputRow>> GetOperatorOutputAsync(INexusOperationsDb db, ReportFilterQuery query, CancellationToken ct)
    {
        var (from, to, _) = Bind(query);
        var pc = query.ProcessCode?.ToUpperInvariant();

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ReportOperatorOutputRow>(new CommandDefinition($"""
            SELECT pu.Username, bo.ProcessCode, AB.UOM,
                   COUNT(DISTINCT bo.ProcessRecordID) AS BatchCount,
                   CAST(SUM(AB.Quantity) AS DECIMAL(14,3)) AS TotalOutput
            FROM prod.BatchOperators bo
            JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = bo.UserID
            JOIN (
                SELECT N'MX' AS ProcessCode, MixingID AS RecordID, TotalWeightKG AS Quantity, N'KG' AS UOM, CompletedAt FROM prod.Mixing WHERE Status=4 AND IsReversed=0
                UNION ALL SELECT N'EX', ExtrusionID, LengthMetres, N'M', CompletedAt FROM prod.Extrusion WHERE Status=4 AND IsReversed=0
                UNION ALL SELECT N'CO', ConvolutingID, LengthMetres, N'M', CompletedAt FROM prod.Convoluting WHERE Status=4 AND IsReversed=0
                UNION ALL SELECT N'BR', BraidingID, LengthMetres, N'M', CompletedAt FROM prod.Braiding WHERE Status=4 AND IsReversed=0
                UNION ALL SELECT N'CL', CoverlineID, LengthMetres, N'M', CompletedAt FROM prod.Coverline WHERE Status=4 AND IsReversed=0
                UNION ALL SELECT N'TW', TapeWrapID, LengthMetres, N'M', CompletedAt FROM prod.TapeWrap WHERE Status=4 AND IsReversed=0
                UNION ALL SELECT N'DR', DrummingID, LengthMetres, N'M', CompletedAt FROM prod.Drumming WHERE Status=4 AND IsReversed=0
            ) AS AB ON AB.ProcessCode = bo.ProcessCode AND AB.RecordID = bo.ProcessRecordID
            WHERE bo.IsPrimary = 1 AND AB.CompletedAt BETWEEN @from AND @to AND (@pc IS NULL OR bo.ProcessCode = @pc)
            GROUP BY pu.Username, bo.ProcessCode, AB.UOM
            ORDER BY TotalOutput DESC
            """, new { from, to, pc }, cancellationToken: ct));
        return rows.ToArray();
    }

    internal static async Task<IReadOnlyList<ReportMaterialOutputRow>> GetMaterialOutputAsync(INexusOperationsDb db, ReportFilterQuery query, CancellationToken ct)
    {
        var (from, to, _) = Bind(query);
        var pc = query.ProcessCode?.ToUpperInvariant();

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ReportMaterialOutputRow>(new CommandDefinition($"""
            SELECT Material, ProcessCode, UOM, COUNT(*) AS BatchCount,
                   CAST(SUM(Quantity) AS DECIMAL(14,3)) AS TotalOutput,
                   CAST(SUM(Quantity)/COUNT(*) AS DECIMAL(14,3)) AS AvgPerBatch
            FROM ({RptCompleted}) AS B
            WHERE CompletedAt BETWEEN @from AND @to AND (@pc IS NULL OR ProcessCode = @pc)
            GROUP BY Material, ProcessCode, UOM
            ORDER BY TotalOutput DESC
            """, new { from, to, pc }, cancellationToken: ct));
        return rows.ToArray();
    }
}
