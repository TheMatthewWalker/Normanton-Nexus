using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Production;

/// <summary>
/// Batch History + Traceability — port of the corresponding sections of
/// routes/productionnexus.js (GET /history, POST /trace, GET
/// /trace/:processCode/:recordId). See ProductionModels.cs's header
/// comment for this sub-phase's scope.
/// </summary>
internal static class ProductionHelper
{
    /// <summary>Every process code's table/PK/ref/qty-column metadata — mirrors the Node PROCESS config map exactly (same 10 codes, same table names).</summary>
    private static readonly Dictionary<string, (string Table, string Pk, string Ref, string Uom, string QtyCol)> Process = new(StringComparer.OrdinalIgnoreCase)
    {
        ["MX"] = ("prod.Mixing", "MixingID", "MixRef", "KG", "TotalWeightKG"),
        ["EX"] = ("prod.Extrusion", "ExtrusionID", "ExtRef", "M", "LengthMetres"),
        ["CO"] = ("prod.Convoluting", "ConvolutingID", "ConvRef", "M", "LengthMetres"),
        ["BR"] = ("prod.Braiding", "BraidingID", "BraidRef", "M", "LengthMetres"),
        ["CL"] = ("prod.Coverline", "CoverlineID", "CovRef", "M", "LengthMetres"),
        ["TW"] = ("prod.TapeWrap", "TapeWrapID", "TWRef", "M", "LengthMetres"),
        ["DR"] = ("prod.Drumming", "DrummingID", "DrumRef", "M", "LengthMetres"),
        ["EW"] = ("prod.Ewald", "EwaldID", "EwaldRef", "EA", "TotalPiecesEA"),
        ["FW"] = ("prod.Firewall", "FirewallID", "FWRef", "EA", "TotalInspectedEA"),
        ["HA"] = ("prod.HoseAssembly", "HoseAssemblyID", "HARef", "EA", "QuantityEA"),
    };

    internal static async Task<IReadOnlyList<BatchHistoryRow>> GetHistoryAsync(INexusOperationsDb db, BatchHistoryQuery query, CancellationToken ct)
    {
        var pageSize = query.PageSize <= 0 ? 50 : query.PageSize;
        var offset = (Math.Max(query.Page, 1) - 1) * pageSize;

        var conditions = new List<string>();
        if (!string.IsNullOrWhiteSpace(query.ProcessCode)) conditions.Add("PC = @pc");
        if (!string.IsNullOrWhiteSpace(query.Material)) conditions.Add("Material = @mat");
        if (!string.IsNullOrWhiteSpace(query.Ref)) conditions.Add("BatchRef LIKE @refLike");
        if (DateTime.TryParse(query.FromDate, out var fromDate)) conditions.Add("CreatedAt >= @from");
        if (DateTime.TryParse(query.ToDate, out var toDate)) conditions.Add("CreatedAt <= @to");
        var innerWhere = conditions.Count > 0 ? $"WHERE {string.Join(" AND ", conditions)}" : "";

        var sql = $"""
            SELECT ProcessCode, RecordID AS RecordId, BatchRef, Material, Quantity, UOM AS Uom, Status, CreatedAt, CompletedAt
            FROM (
                SELECT ROW_NUMBER() OVER (ORDER BY CreatedAt DESC) AS RowNum,
                       PC AS ProcessCode, RID AS RecordID, BatchRef, Material, Qty AS Quantity, UOM, Status, CreatedAt, CompletedAt
                FROM (
                    SELECT N'MX' AS PC, MixingID AS RID, MixRef AS BatchRef, Material, CAST(TotalWeightKG AS DECIMAL(12,3)) AS Qty, N'KG' AS UOM, Status, CreatedAt, CompletedAt FROM prod.Mixing
                    UNION ALL SELECT N'EX', ExtrusionID, ExtRef, Material, LengthMetres, N'M', Status, CreatedAt, CompletedAt FROM prod.Extrusion
                    UNION ALL SELECT N'CO', ConvolutingID, ConvRef, Material, LengthMetres, N'M', Status, CreatedAt, CompletedAt FROM prod.Convoluting
                    UNION ALL SELECT N'BR', BraidingID, BraidRef, Material, LengthMetres, N'M', Status, CreatedAt, CompletedAt FROM prod.Braiding
                    UNION ALL SELECT N'CL', CoverlineID, CovRef, Material, LengthMetres, N'M', Status, CreatedAt, CompletedAt FROM prod.Coverline
                    UNION ALL SELECT N'TW', TapeWrapID, TWRef, Material, LengthMetres, N'M', Status, CreatedAt, CompletedAt FROM prod.TapeWrap
                    UNION ALL SELECT N'DR', DrummingID, DrumRef, Material, LengthMetres, N'M', Status, CreatedAt, CompletedAt FROM prod.Drumming
                    UNION ALL SELECT N'EW', EwaldID, EwaldRef, Material, CAST(TotalPiecesEA AS DECIMAL(12,3)), N'EA', Status, CreatedAt, CompletedAt FROM prod.Ewald
                    UNION ALL SELECT N'HA', HoseAssemblyID, HARef, Material, CAST(QuantityEA AS DECIMAL(12,3)), N'EA', Status, CreatedAt, CompletedAt FROM prod.HoseAssembly
                ) AS AllBatches
                {innerWhere}
            ) AS Paged
            WHERE RowNum > @offset AND RowNum <= (@offset + @pageSize)
            ORDER BY CreatedAt DESC
            """;

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<BatchHistoryRow>(new CommandDefinition(sql, new
        {
            pc = query.ProcessCode?.ToUpperInvariant(),
            mat = query.Material,
            refLike = query.Ref is null ? null : $"%{query.Ref}%",
            from = fromDate,
            to = toDate,
            offset,
            pageSize,
        }, cancellationToken: ct));
        return rows.ToArray();
    }

    internal static async Task AddTraceLinkAsync(INexusOperationsDb db, TraceLinkCreateRequest body, string? username, int userId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.ChildProcessCode) || string.IsNullOrWhiteSpace(body.ParentProcessCode)
            || body.ChildRecordId <= 0 || body.ParentRecordId <= 0)
        {
            throw new NexusValidationException("childProcessCode, childRecordId, parentProcessCode and parentRecordId are required.");
        }

        using var connection = await db.CreateConnectionAsync(ct);
        try
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO prod.ProductionTrace (ChildProcessCode, ChildRecordID, ParentProcessCode, ParentRecordID, LinkedByUserID)
                VALUES (@cc, @cr, @pc, @pr, @uid)
                """, new
            {
                cc = body.ChildProcessCode.ToUpperInvariant(),
                cr = body.ChildRecordId,
                pc = body.ParentProcessCode.ToUpperInvariant(),
                pr = body.ParentRecordId,
                uid = userId,
            }, cancellationToken: ct));
        }
        catch (Microsoft.Data.SqlClient.SqlException ex) when (ex.Number == 2627)
        {
            throw new NexusValidationException("This trace link already exists.");
        }
    }

    internal static async Task<TraceChainResult> GetTraceChainAsync(INexusOperationsDb db, string processCode, int recordId, CancellationToken ct)
    {
        var code = processCode.ToUpperInvariant();
        using var connection = await db.CreateConnectionAsync(ct);

        var chain = (await connection.QueryAsync<TraceChainLink>(new CommandDefinition("""
            WITH TraceChain AS (
                SELECT ChildProcessCode, ChildRecordID AS ChildRecordId, ParentProcessCode, ParentRecordID AS ParentRecordId, 0 AS Depth
                FROM prod.ProductionTrace
                WHERE ChildProcessCode = @cc AND ChildRecordID = @cr
                UNION ALL
                SELECT t.ChildProcessCode, t.ChildRecordID, t.ParentProcessCode, t.ParentRecordID, tc.Depth + 1
                FROM prod.ProductionTrace t
                INNER JOIN TraceChain tc ON t.ChildProcessCode = tc.ParentProcessCode AND t.ChildRecordID = tc.ParentRecordId
            )
            SELECT * FROM TraceChain ORDER BY Depth
            """, new { cc = code, cr = recordId }, cancellationToken: ct))).ToList();

        var pairs = new Dictionary<string, (string Pc, int Rid)>();
        void AddPair(string pc, int rid)
        {
            if (!Process.ContainsKey(pc)) return;
            pairs[$"{pc}-{rid}"] = (pc, rid);
        }
        AddPair(code, recordId);
        foreach (var link in chain)
        {
            AddPair(link.ChildProcessCode, link.ChildRecordId);
            AddPair(link.ParentProcessCode, link.ParentRecordId);
        }

        var details = new Dictionary<string, TraceDetailRow>();
        foreach (var group in pairs.Values.GroupBy(p => p.Pc))
        {
            var (table, pk, refCol, uom, qtyCol) = Process[group.Key];
            var ids = group.Select(g => g.Rid).ToArray();
            var sql = $"""
                SELECT '{group.Key}' AS ProcessCode, t.{pk} AS RecordId, t.{refCol} AS BatchRef, t.Material,
                       CAST(t.{qtyCol} AS DECIMAL(14,3)) AS Quantity, '{uom}' AS Uom, t.CreatedAt, pu.Username AS Operator
                FROM {table} t
                LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = t.CreatedByUserID
                WHERE t.{pk} IN @ids
                """;
            var rows = await connection.QueryAsync<TraceDetailRow>(new CommandDefinition(sql, new { ids }, cancellationToken: ct));
            foreach (var row in rows)
            {
                details[$"{row.ProcessCode}-{row.RecordId}"] = row;
            }
        }

        return new TraceChainResult(chain, details);
    }
}
