using Dapper;
using Microsoft.Data.SqlClient;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Production;

/// <summary>
/// BOM download/persistence/validation + Traceability Concession raising —
/// shared infrastructure port of routes/productionnexus.js's fetchBom/
/// persistBomSnapshot/latestBomSnapshot/validateRawMaterialBatches/
/// validateTraceabilityAgainstBom/unresolvedProblems/approvedConcessions/
/// buildActualComponentList, plus the process-generic BOM/raw-material-
/// batch/concession routes. Backs the not-yet-built CO/BR/CL/TW draft→
/// complete wizard and Drumming's entry flow — this slice is the reusable
/// infrastructure both will need, not either wizard itself.
/// </summary>
internal static class BomHelper
{
    /// <summary>The 5 processes that get a downloaded-and-saved BOM snapshot — mirrors Node's BOM_VALIDATED_PROCESSES exactly. EX/MX use a separate, tub-staging-aware check (validateMxTubLinks in Node) not covered here.</summary>
    internal static readonly HashSet<string> BomValidatedProcesses = new(StringComparer.OrdinalIgnoreCase) { "CO", "BR", "CL", "TW", "DR" };

    /// <summary>Materials at this SAP profit centre are raw materials — bought in, never produced by any Normanton-Nexus process, so there's no portal record to resolve a traceability link against. Mirrors Node's RAW_MATERIAL_PROFIT_CENTRE exactly.</summary>
    private const string RawMaterialProfitCentre = "2012";

    // ── SAP fetch ────────────────────────────────────────────────────────────

    /// <summary>Live BOM lookup for the finished/produced good, enriched with each component's profit centre (one bulk call, not one per component). Mirrors Node's fetchBom exactly.</summary>
    internal static async Task<IReadOnlyList<BomRow>> FetchBomAsync(ISapServerClient sap, string material, int userId, CancellationToken ct)
    {
        var rawRows = await sap.GetAsync<List<SapBomRow>>("api/production/bom", userId, new SapBomQuery(material), ct: ct) ?? [];
        if (rawRows.Count == 0) return [];

        var profitCentres = await FetchProfitCentresAsync(sap, rawRows.Select(r => r.Component).ToList(), userId, ct);
        return rawRows.Select(r =>
        {
            profitCentres.TryGetValue(r.Component, out var pc);
            return new BomRow(r.Component, r.ComponentQty, r.ComponentUnit, r.Item, r.StorageLocation, pc, pc == RawMaterialProfitCentre);
        }).ToList();
    }

    /// <summary>Bulk profit-centre lookup for every distinct material in one SAP round trip. Mirrors Node's fetchProfitCentres exactly, including never throwing (a failed lookup here means every component classifies as non-raw-material rather than blowing up the whole BOM fetch).</summary>
    internal static async Task<Dictionary<string, string>> FetchProfitCentresAsync(ISapServerClient sap, IReadOnlyList<string> materials, int userId, CancellationToken ct)
    {
        var distinct = materials.Where(m => !string.IsNullOrEmpty(m)).Distinct().ToList();
        if (distinct.Count == 0) return [];

        try
        {
            var rows = await sap.GetAsync<List<SapProfitCentreRow>>("api/production/check-profit-centres", userId, new SapProfitCentresRequest(distinct), ct: ct) ?? [];
            return rows.ToDictionary(r => r.Material, r => r.ProfitCentre.TrimStart('0'));
        }
        catch
        {
            return [];
        }
    }

    // ── Persistence ──────────────────────────────────────────────────────────

    /// <summary>Never deletes a prior batch (see the /bom/refresh action) so DownloadedAt always distinguishes the creation-time snapshot from any later refresh, keeping "what BOM was this job built against" intact for audit even after a refresh changes what validation uses going forward.</summary>
    internal static async Task PersistBomSnapshotAsync(SqlConnection connection, string code, int recordId, string material, IReadOnlyList<BomRow> bomRows, CancellationToken ct)
    {
        foreach (var r in bomRows)
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO prod.ProductionBom
                    (ProcessCode,RecordID,Material,Component,Item,ComponentQty,ComponentUnit,StorageLocation,ProfitCentre)
                VALUES (@code,@recordId,@material,@component,@item,@qty,@unit,@sloc,@prctr)
                """, new
            {
                code,
                recordId,
                material,
                component = r.Component,
                item = r.Item,
                qty = r.ComponentQty,
                unit = r.ComponentUnit,
                sloc = r.StorageLocation,
                prctr = r.ProfitCentre
            }, cancellationToken: ct));
        }
    }

    /// <summary>Reads back the LATEST persisted BOM batch (MAX(DownloadedAt)) for a job. Returned shape matches FetchBomAsync's live rows so both feed the same validation/rendering code paths interchangeably.</summary>
    internal static async Task<IReadOnlyList<BomRow>> LatestBomSnapshotAsync(INexusOperationsDb db, string code, int recordId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await LatestBomSnapshotAsync(connection, code, recordId, ct);
    }

    internal static async Task<IReadOnlyList<BomRow>> LatestBomSnapshotAsync(SqlConnection connection, string code, int recordId, CancellationToken ct)
    {
        var rows = await connection.QueryAsync<(string Component, decimal ComponentQty, string ComponentUnit, string? Item, string? StorageLocation, string? ProfitCentre)>(
            new CommandDefinition("""
                SELECT Component, ComponentQty, ComponentUnit, Item, StorageLocation, ProfitCentre
                FROM prod.ProductionBom
                WHERE ProcessCode = @code AND RecordID = @recordId
                  AND DownloadedAt = (SELECT MAX(DownloadedAt) FROM prod.ProductionBom WHERE ProcessCode = @code AND RecordID = @recordId)
                """, new { code, recordId }, cancellationToken: ct));

        return rows.Select(r => new BomRow(r.Component, r.ComponentQty, r.ComponentUnit, r.Item, r.StorageLocation, r.ProfitCentre, r.ProfitCentre == RawMaterialProfitCentre)).ToList();
    }

    // ── Raw-material batches (hand-written, no resolving) ────────────────────

    internal static async Task<IReadOnlyList<RawMaterialBatchRow>> GetRawMaterialBatchesAsync(INexusOperationsDb db, string code, int recordId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<RawMaterialBatchRow>(new CommandDefinition(
            "SELECT BatchID AS BatchId, Material, BatchNumber FROM prod.RawMaterialBatches WHERE ProcessCode = @code AND RecordID = @recordId ORDER BY LinkedAt",
            new { code, recordId }, cancellationToken: ct));
        return rows.AsList();
    }

    /// <summary>Inserted unconditionally (same "insert now, validate separately" pattern as parentBatches → prod.ProductionTrace) — ValidateRawMaterialBatchesAsync decides whether what's here actually satisfies the job's BOM.</summary>
    internal static async Task PersistRawMaterialBatchesAsync(SqlConnection connection, string code, int recordId, int userId, IEnumerable<RawMaterialBatchInput> batches, CancellationToken ct)
    {
        foreach (var rb in batches)
        {
            var batchNumber = (rb.BatchNumber ?? "").Trim();
            if (string.IsNullOrEmpty(rb.Material) || batchNumber.Length == 0) continue;

            await connection.ExecuteAsync(new CommandDefinition(
                "INSERT INTO prod.RawMaterialBatches (ProcessCode,RecordID,Material,BatchNumber,LinkedByUserID) VALUES (@code,@recordId,@material,@batchNumber,@userId)",
                new { code, recordId, material = rb.Material, batchNumber, userId }, cancellationToken: ct));
        }
    }

    /// <summary>POST /process/:pc/:id/raw-material-batch — the single-entry form endpoint (as opposed to draft/submitDrumming's bulk PersistRawMaterialBatchesAsync call in the same request as job creation).</summary>
    internal static async Task AddRawMaterialBatchAsync(INexusOperationsDb db, string code, int recordId, AddRawMaterialBatchRequest body, int userId, CancellationToken ct)
    {
        if (!BomValidatedProcesses.Contains(code))
            throw new NexusValidationException($"{code} is not handled by this endpoint.");
        if (string.IsNullOrWhiteSpace(body.Material) || string.IsNullOrWhiteSpace(body.BatchNumber))
            throw new NexusValidationException("material and batchNumber are required.");

        using var connection = await db.CreateConnectionAsync(ct);
        await PersistRawMaterialBatchesAsync(connection, code, recordId, userId, [new RawMaterialBatchInput(body.Material, body.BatchNumber)], ct);
        await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "NOTE",
            $"Raw material batch recorded for {body.Material}: {body.BatchNumber.Trim()}", 0, userId, ct);
    }

    internal static async Task<int> DeleteRawMaterialBatchAsync(INexusOperationsDb db, int batchId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.ExecuteAsync(new CommandDefinition(
            "DELETE FROM prod.RawMaterialBatches WHERE BatchID = @batchId", new { batchId }, cancellationToken: ct));
    }

    // ── Validation ───────────────────────────────────────────────────────────

    /// <summary>Checks every raw-material BOM component has at least one hand-written batch number recorded. Unlike ValidateTraceabilityAgainstBomAsync, there's nothing to mismatch here (no portal record to pick the "wrong" one of) — only a missing entry — so these problems are never concession-eligible and always hard-block completion until filled in.</summary>
    internal static async Task<IReadOnlyList<TraceabilityProblem>> ValidateRawMaterialBatchesAsync(SqlConnection connection, string code, int recordId, IReadOnlyList<BomRow> bomRows, CancellationToken ct)
    {
        var rawComponents = bomRows.Where(r => r.IsRawMaterial).Select(r => r.Component).Distinct().ToList();
        if (rawComponents.Count == 0) return [];

        var recorded = (await connection.QueryAsync<string>(new CommandDefinition(
            "SELECT DISTINCT Material FROM prod.RawMaterialBatches WHERE ProcessCode = @code AND RecordID = @recordId",
            new { code, recordId }, cancellationToken: ct))).ToHashSet();

        return rawComponents.Where(mat => !recorded.Contains(mat))
            .Select(mat => new TraceabilityProblem(null, null, mat, $"{mat} is a raw material (profit centre {RawMaterialProfitCentre}) — enter its supplier/SAP batch number."))
            .ToList();
    }

    /// <summary>Resolves each linked parent's own Material and checks it belongs to the BOM's component set — NOT whether it was linked under the "right" checklist row on the client, which is purely presentational grouping. Mirrors Node's validateTraceabilityAgainstBom exactly, including skipping (not failing on) an unrecognized process code.</summary>
    internal static async Task<IReadOnlyList<TraceabilityProblem>> ValidateTraceabilityAgainstBomAsync(SqlConnection connection, IReadOnlyList<ParentBatchLink> parentBatches, IReadOnlyList<BomRow> bomRows, CancellationToken ct)
    {
        var bomMaterials = bomRows.Select(r => r.Component).ToHashSet();
        var problems = new List<TraceabilityProblem>();

        foreach (var pb in parentBatches)
        {
            if (!ProductionSapHelpers.Process.TryGetValue(pb.ProcessCode, out var cfg)) continue;

            var mat = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
                $"SELECT Material FROM {cfg.Table} WHERE {cfg.Pk} = @recordId", new { recordId = pb.RecordId }, cancellationToken: ct));

            var label = $"{pb.ProcessCode.ToUpperInvariant()}{pb.RecordId:D8}";
            if (mat is null) { problems.Add(new TraceabilityProblem(pb.ProcessCode, pb.RecordId, null, $"{label} not found.")); continue; }
            if (!bomMaterials.Contains(mat))
                problems.Add(new TraceabilityProblem(pb.ProcessCode, pb.RecordId, mat, $"{label}'s material ({mat}) is not a component of this job's BOM."));
        }

        return problems;
    }

    /// <summary>Filters problems down to those NOT covered by an APPROVED concession — this is what actually gates completion/posting. Mirrors Node's unresolvedProblems exactly.</summary>
    internal static async Task<IReadOnlyList<TraceabilityProblem>> UnresolvedProblemsAsync(SqlConnection connection, string code, int recordId, IReadOnlyList<TraceabilityProblem> problems, CancellationToken ct)
    {
        var result = new List<TraceabilityProblem>();
        foreach (var p in problems)
        {
            if (p.ProcessCode is null || p.RecordId is null) { result.Add(p); continue; }

            var covered = await connection.QuerySingleOrDefaultAsync<int?>(new CommandDefinition("""
                SELECT TOP 1 1 FROM prod.TraceabilityConcessions
                WHERE ProcessCode = @code AND RecordID = @recordId AND ParentProcessCode = @ppc AND ParentRecordID = @prid AND Status = N'APPROVED'
                """, new { code, recordId, ppc = p.ProcessCode, prid = p.RecordId }, cancellationToken: ct));

            if (covered is null) result.Add(p);
        }
        return result;
    }

    internal static async Task<IReadOnlyList<ApprovedConcessionRow>> ApprovedConcessionsAsync(SqlConnection connection, string code, int recordId, CancellationToken ct)
    {
        var rows = await connection.QueryAsync<ApprovedConcessionRow>(new CommandDefinition("""
            SELECT ConcessionID AS ConcessionId, Component, ActualMaterial, Quantity
            FROM prod.TraceabilityConcessions WHERE ProcessCode = @code AND RecordID = @recordId AND Status = N'APPROVED'
            """, new { code, recordId }, cancellationToken: ct));
        return rows.AsList();
    }

    /// <summary>Every component posted explicitly (correct ones included), not just the mismatched one — the normal automatic BOM-driven backflush must never also silently consume the original wrong material on top of this explicit posting. Mirrors Node's buildActualComponentList exactly, including the concession-quantity-overrides-computed-quantity precedence.</summary>
    internal static List<ActualComponent> BuildActualComponentList(IReadOnlyList<BomRow> bomRows, IReadOnlyList<ApprovedConcessionRow> concessions, decimal totalQty)
    {
        return bomRows.Select(row =>
        {
            var concession = concessions.FirstOrDefault(c => c.Component == row.Component);
            var material = concession?.ActualMaterial ?? row.Component;
            var quantity = concession?.Quantity ?? Math.Round(row.ComponentQty * totalQty, 3);
            return new ActualComponent(material, quantity, row.ComponentUnit, row.StorageLocation);
        }).ToList();
    }

    // ── Controller-facing wrappers (validation + DB open) ───────────────────

    /// <summary>GET /process/:pc/bom-preview — a live SAP BOM lookup for a not-yet-created job, before the operator has anything to persist against. Mirrors Node's own route validation exactly.</summary>
    internal static async Task<IReadOnlyList<BomRow>> GetBomPreviewAsync(ISapServerClient sap, string code, string? material, int userId, CancellationToken ct)
    {
        if (!BomValidatedProcesses.Contains(code))
            throw new NexusValidationException($"{code} is not handled by this endpoint.");
        if (string.IsNullOrWhiteSpace(material))
            throw new NexusValidationException("material is required.");

        return await FetchBomAsync(sap, material, userId, ct);
    }

    /// <summary>GET /process/:pc/:id/bom — the persisted snapshot for an existing job (the LATEST batch), so the checklist/validation re-renders against what was actually saved, not a possibly-since-changed live BOM.</summary>
    internal static async Task<IReadOnlyList<BomRow>> GetLatestBomAsync(INexusOperationsDb db, string code, int recordId, CancellationToken ct)
    {
        if (!BomValidatedProcesses.Contains(code))
            throw new NexusValidationException($"{code} is not handled by this endpoint.");

        return await LatestBomSnapshotAsync(db, code, recordId, ct);
    }

    /// <summary>
    /// POST /process/:pc/:id/bom/refresh — re-downloads the BOM from SAP and
    /// appends a new snapshot batch, for when the real fix for a mismatch
    /// was correcting the BOM in SAP, not raising a concession. Never
    /// deletes the prior batch, and re-runs the traceability check against
    /// the fresh rows so the caller can immediately see which problems (if
    /// any) the refresh resolved.
    /// </summary>
    internal static async Task<BomRefreshResult> RefreshBomAsync(INexusOperationsDb db, ISapServerClient sap, string code, int recordId, int userId, CancellationToken ct)
    {
        if (!BomValidatedProcesses.Contains(code))
            throw new NexusValidationException($"{code} is not handled by this endpoint.");
        if (!ProductionSapHelpers.Process.TryGetValue(code, out var cfg))
            throw new NexusValidationException($"Unknown process code: {code}");

        using var connection = await db.CreateConnectionAsync(ct);

        var material = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            $"SELECT Material FROM {cfg.Table} WHERE {cfg.Pk} = @recordId", new { recordId }, cancellationToken: ct));
        if (material is null) throw new NexusNotFoundException("Job not found.");

        var bomRows = await FetchBomAsync(sap, material, userId, ct);
        await PersistBomSnapshotAsync(connection, code, recordId, material, bomRows, ct);
        await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "NOTE",
            $"BOM re-downloaded from SAP (refresh) — {bomRows.Count} component(s).", 0, userId, ct);

        var parentBatches = await GetParentBatchLinksAsync(connection, code, recordId, ct);
        var problems = await ValidateTraceabilityAgainstBomAsync(connection, parentBatches, bomRows, ct);

        return new BomRefreshResult(bomRows, problems);
    }

    /// <summary>GET /process/:pc/:id/trace — the parent-batch links already saved against a job (flat prod.ProductionTrace read), used by the Complete Run wizard's read-only Traceability Check step. Not scoped to BomValidatedProcesses — a plain read, useful for any process code.</summary>
    internal static async Task<IReadOnlyList<ParentBatchLink>> GetParentBatchLinksAsync(INexusOperationsDb db, string code, int recordId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await GetParentBatchLinksAsync(connection, code, recordId, ct);
    }

    private static async Task<IReadOnlyList<ParentBatchLink>> GetParentBatchLinksAsync(SqlConnection connection, string code, int recordId, CancellationToken ct)
    {
        var rows = await connection.QueryAsync<ParentBatchLink>(new CommandDefinition(
            "SELECT ParentProcessCode AS ProcessCode, ParentRecordID AS RecordId FROM prod.ProductionTrace WHERE ChildProcessCode = @code AND ChildRecordID = @recordId",
            new { code, recordId }, cancellationToken: ct));
        return rows.AsList();
    }

    // ── Concession raising (Production's half — Quality's Phase 3 built the review half) ──

    internal static async Task<RaiseConcessionResult> RaiseConcessionAsync(
        INexusOperationsDb db, string code, int recordId, RaiseConcessionRequest body, int userId, CancellationToken ct)
    {
        if (!BomValidatedProcesses.Contains(code))
            throw new NexusValidationException($"{code} is not handled by this endpoint.");
        if (string.IsNullOrWhiteSpace(body.ParentProcessCode) || string.IsNullOrWhiteSpace(body.Component)
            || string.IsNullOrWhiteSpace(body.ActualMaterial) || string.IsNullOrWhiteSpace(body.Reason))
        {
            throw new NexusValidationException("parentProcessCode, parentRecordId, component, actualMaterial and reason are required.");
        }

        var ppc = body.ParentProcessCode.ToUpperInvariant();

        using var connection = await db.CreateConnectionAsync(ct);

        var existing = await connection.QuerySingleOrDefaultAsync<int?>(new CommandDefinition("""
            SELECT TOP 1 ConcessionID FROM prod.TraceabilityConcessions
            WHERE ProcessCode = @code AND RecordID = @recordId AND ParentProcessCode = @ppc AND ParentRecordID = @prid AND Status IN (N'PENDING', N'APPROVED')
            """, new { code, recordId, ppc, prid = body.ParentRecordId }, cancellationToken: ct));

        if (existing is not null)
            throw new NexusConflictException("A concession for this link is already pending or approved.");

        var reason = body.Reason.Trim();
        var concessionId = await connection.QuerySingleAsync<int>(new CommandDefinition("""
            INSERT INTO prod.TraceabilityConcessions
                (ProcessCode,RecordID,ParentProcessCode,ParentRecordID,Component,ActualMaterial,Quantity,Reason,RaisedByUserID)
            OUTPUT INSERTED.ConcessionID
            VALUES (@code,@recordId,@ppc,@prid,@component,@actualMaterial,@quantity,@reason,@userId)
            """, new
        {
            code,
            recordId,
            ppc,
            prid = body.ParentRecordId,
            component = body.Component,
            actualMaterial = body.ActualMaterial,
            quantity = body.Quantity,
            reason,
            userId
        }, cancellationToken: ct));

        await ProductionEventLogHelper.WriteEventAsync(connection, code, recordId, "NOTE",
            $"Traceability concession raised for {ppc}{body.ParentRecordId:D8} ({body.Component} → {body.ActualMaterial}): {reason}", 1, userId, ct);

        // notify() (in-app notification to QUAL_CONCESSION holders) deliberately
        // not wired up — same deferred-Notifications-feature precedent as
        // Quality's own ReviewConcessionAsync and every Production write action.

        return new RaiseConcessionResult(concessionId);
    }
}
