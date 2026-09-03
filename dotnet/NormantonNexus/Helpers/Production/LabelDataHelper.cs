using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Production;

/// <summary>
/// Fetches the data a production label needs — port of fetchLabelData/
/// fetchMixingHeader/fetchMixingTicketsData in routes/labels.js. Shared by
/// the browser-preview HTML route; server-side PDF printing (not yet
/// built) will call the same fetch methods once it lands.
/// </summary>
internal static class LabelDataHelper
{
    /// <summary>The 7 process codes labels.js supports — mirrors Node's SUPPORTED Set exactly (a subset of ProductionSapHelpers.Process — no EW/FW/HA label support in Node either).</summary>
    internal static readonly HashSet<string> SupportedProcessCodes = new(StringComparer.OrdinalIgnoreCase) { "MX", "EX", "CO", "BR", "CL", "TW", "DR" };

    private static readonly Dictionary<string, string> ProcessNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ["MX"] = "Mixing",
        ["EX"] = "Extrusion",
        ["CO"] = "Convoluting",
        ["BR"] = "Braiding",
        ["CL"] = "Coverline",
        ["TW"] = "Tape Wrap",
        ["DR"] = "Drumming",
    };

    private const string DisplayNameSql = "COALESCE(NULLIF(RTRIM(ISNULL(pu.FirstName,'')+' '+ISNULL(pu.LastName,'')), ''), pu.Username) AS DisplayName";

    /// <summary>Raw row shape shared by both the Mixing and generic-process branches of FetchLabelDataAsync — mapped by Dapper via property name, not position, since a positional ValueTuple this wide risks exceeding Dapper's reliable tuple-mapping depth.</summary>
    private sealed record LabelRawRow(
        string? Material, decimal? Quantity, int Status, DateTime? CreatedAt, DateTime? CompletedAt, string? Notes,
        string? MachineName, string? MachineCode, string? DisplayName,
        string? BatchRef, string? SupplierBatchNo, string? SupplierTubNo);

    // ── Every process except Mixing (single combined record + batch-generic ref) ──

    internal static async Task<LabelData> FetchLabelDataAsync(INexusOperationsDb db, string processCode, int recordId, CancellationToken ct)
    {
        var cfg = ProductionSapHelpers.Process[processCode];
        using var connection = await db.CreateConnectionAsync(ct);

        LabelRawRow? r;

        if (string.Equals(processCode, "MX", StringComparison.OrdinalIgnoreCase))
        {
            r = await connection.QuerySingleOrDefaultAsync<LabelRawRow>(new CommandDefinition($"""
                SELECT m.Material, m.TotalWeightKG AS Quantity,
                       m.Status, m.CreatedAt, m.CompletedAt, m.Notes,
                       NULL AS MachineName, NULL AS MachineCode,
                       {DisplayNameSql},
                       m.MixRef AS BatchRef, m.SupplierBatchNo, m.SupplierTubNo
                FROM   prod.Mixing m
                LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = m.CreatedByUserID
                WHERE  m.MixingID = @recordId
                """, new { recordId }, cancellationToken: ct));
        }
        else
        {
            r = await connection.QuerySingleOrDefaultAsync<LabelRawRow>(new CommandDefinition($"""
                SELECT t.Material, t.{cfg.QtyCol} AS Quantity,
                       t.Status, t.CreatedAt, t.CompletedAt, t.Notes,
                       mc.MachineName, mc.MachineCode,
                       {DisplayNameSql},
                       NULL AS BatchRef, NULL AS SupplierBatchNo, NULL AS SupplierTubNo
                FROM   {cfg.Table} t
                LEFT JOIN prod.Machines mc ON mc.MachineID = t.MachineID
                LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = t.CreatedByUserID
                WHERE  t.{cfg.Pk} = @recordId
                """, new { recordId }, cancellationToken: ct));
        }

        if (r is null) throw new NexusNotFoundException("Record not found.");

        var operators = (await connection.QueryAsync<LabelOperatorRow>(new CommandDefinition($"""
            SELECT bo.IsPrimary, pu.Username, {DisplayNameSql}
            FROM   prod.BatchOperators bo
            JOIN   Nexus.dbo.PortalUsers pu ON pu.UserID = bo.UserID
            WHERE  bo.ProcessCode = @processCode AND bo.ProcessRecordID = @recordId
              AND  bo.RemovedAt IS NULL
            ORDER  BY bo.IsPrimary DESC, bo.AssignedAt
            """, new { processCode, recordId }, cancellationToken: ct))).AsList();

        var parentBatches = (await connection.QueryAsync<(string ParentProcessCode, int ParentRecordId)>(new CommandDefinition("""
            SELECT ParentProcessCode, ParentRecordID
            FROM   prod.ProductionTrace
            WHERE  ChildProcessCode = @processCode AND ChildRecordID = @recordId
            ORDER  BY LinkedAt
            """, new { processCode, recordId }, cancellationToken: ct)))
            .Select(p => $"{p.ParentProcessCode}{p.ParentRecordId:D8}")
            .ToList();

        string? sapMatDoc = null;
        if (r.Status == 4 && !string.Equals(processCode, "BR", StringComparison.OrdinalIgnoreCase))
        {
            sapMatDoc = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition("""
                SELECT TOP 1 MaterialDocumentSAP
                FROM   prod.SAPPostings
                WHERE  ProcessCode = @processCode AND ProcessRecordID = @recordId
                  AND  PostingType = 'BACKFLUSH' AND IsSuccess = 1 AND IsReversed = 0
                ORDER  BY PostedAt
                """, new { processCode, recordId }, cancellationToken: ct));
        }

        var batchRef = string.Equals(processCode, "MX", StringComparison.OrdinalIgnoreCase)
            ? (r.BatchRef ?? $"MX{recordId:D8}")
            : $"{processCode.ToUpperInvariant()}{recordId:D8}";

        return new LabelData(
            ProcessCode: processCode.ToUpperInvariant(),
            ProcessName: ProcessNames[processCode],
            BatchRef: batchRef,
            Status: r.Status,
            Material: r.Material ?? "—",
            Machine: r.MachineName ?? r.MachineCode,
            Operators: operators,
            CreatedAt: r.CreatedAt,
            CompletedAt: r.CompletedAt,
            Quantity: r.Quantity,
            Uom: cfg.Uom,
            ParentBatches: parentBatches,
            SapMatDoc: sapMatDoc,
            Notes: r.Notes,
            SupplierBatchNo: r.SupplierBatchNo,
            SupplierTubNo: r.SupplierTubNo);
    }

    // ── Mixing — one ticket per tub ──────────────────────────────────────────
    // A Mixing entry backflushes each tub to SAP separately, so a single
    // combined-batch label would show the whole batch's weight and only the
    // first tub's SAP material document — silently dropping the rest. This
    // builds one LabelData per tub instead, each carrying that tub's own
    // weight/SAP document/supplier tub number. Mirrors Node's
    // fetchMixingTicketsData exactly, including its own header comment's
    // reasoning.

    internal static async Task<IReadOnlyList<LabelData>> FetchMixingTicketsDataAsync(INexusOperationsDb db, int recordId, int? tubSeq, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var rec = await connection.QuerySingleOrDefaultAsync<(string? BatchRef, string? Material, int Status, DateTime? CreatedAt, DateTime? CompletedAt, string? Notes, string? SupplierBatchNo)?>(
            new CommandDefinition("""
                SELECT m.MixRef AS BatchRef, m.Material, m.Status, m.CreatedAt, m.CompletedAt, m.Notes, m.SupplierBatchNo
                FROM   prod.Mixing m
                WHERE  m.MixingID = @recordId
                """, new { recordId }, cancellationToken: ct));

        if (rec is null) throw new NexusNotFoundException("Record not found.");
        var r = rec.Value;

        var operators = (await connection.QueryAsync<LabelOperatorRow>(new CommandDefinition($"""
            SELECT bo.IsPrimary, pu.Username, {DisplayNameSql}
            FROM   prod.BatchOperators bo
            JOIN   Nexus.dbo.PortalUsers pu ON pu.UserID = bo.UserID
            WHERE  bo.ProcessCode = 'MX' AND bo.ProcessRecordID = @recordId
              AND  bo.RemovedAt IS NULL
            ORDER  BY bo.IsPrimary DESC, bo.AssignedAt
            """, new { recordId }, cancellationToken: ct))).AsList();

        var allTubs = (await connection.QueryAsync<(int TubId, int TubSeq, string? SupplierTubNo, decimal TubWeightKg, string? MaterialDocumentSap, bool SapSuccess)>(
            new CommandDefinition("""
                SELECT TubID, TubSeq, SupplierTubNo, TubWeightKG, MaterialDocumentSAP, SAPSuccess
                FROM   prod.MixingTubs
                WHERE  MixingID = @recordId
                ORDER  BY TubSeq
                """, new { recordId }, cancellationToken: ct))).AsList();

        var baseBatchRef = r.BatchRef ?? $"MX{recordId:D8}";
        var isComplete = r.Status == 4;

        var tubs = allTubs;
        if (tubSeq is not null)
        {
            tubs = allTubs.Where(t => t.TubSeq == tubSeq.Value).ToList();
            if (tubs.Count == 0)
                throw new NexusNotFoundException($"Tub {tubSeq} not found on this mixing batch.");
        }

        if (tubs.Count == 0)
        {
            // No tub rows yet (legacy record, or printed before any tub was
            // weighed) — one ticket for the whole batch so printing never
            // silently produces nothing. Only reachable when tubSeq wasn't
            // specified (the filtered-empty case above already threw).
            return
            [
                new LabelData(
                    ProcessCode: "MX", ProcessName: ProcessNames["MX"], BatchRef: baseBatchRef, Status: r.Status,
                    Material: r.Material ?? "—", Machine: null, Operators: operators,
                    CreatedAt: r.CreatedAt, CompletedAt: r.CompletedAt, Quantity: null, Uom: ProductionSapHelpers.Process["MX"].Uom,
                    ParentBatches: [], SapMatDoc: null, Notes: r.Notes, SupplierBatchNo: r.SupplierBatchNo, SupplierTubNo: null)
            ];
        }

        return tubs.Select(t => new LabelData(
            ProcessCode: "MX", ProcessName: ProcessNames["MX"], BatchRef: $"{baseBatchRef}-T{t.TubSeq}", Status: r.Status,
            Material: r.Material ?? "—", Machine: null, Operators: operators,
            CreatedAt: r.CreatedAt, CompletedAt: r.CompletedAt, Quantity: t.TubWeightKg, Uom: ProductionSapHelpers.Process["MX"].Uom,
            ParentBatches: [], SapMatDoc: isComplete && t.SapSuccess && t.MaterialDocumentSap is { Length: > 0 } ? t.MaterialDocumentSap : null,
            Notes: r.Notes, SupplierBatchNo: r.SupplierBatchNo, SupplierTubNo: t.SupplierTubNo))
            .ToList();
    }
}
