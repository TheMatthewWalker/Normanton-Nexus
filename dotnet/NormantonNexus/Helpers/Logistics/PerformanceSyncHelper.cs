using Microsoft.AspNetCore.WebUtilities;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Performance/MRP Analysis refresh orchestration — Logistics Sub-phase 8b.6.
/// Port of routes/performancesync.js: runFullRefresh (Stock/Agreements/
/// Invoicing/Otif, the 30-min cron + manual "Refresh Now"), runTurnsValClass
/// Refresh (TurnsValClass/ValuationClasses, the daily 05:45 cron + manual
/// refresh), runMrpHistoryRefresh (MrpAnalysisHistory, the weekly cron +
/// manual refresh). Each dataset gets its own dbo.RefreshLog run (Nexus
/// database) wrapping the actual SAP-pull + snapshot-write work (NexusOps
/// database) — see PerformanceSnapshotHelper for the table writes and
/// StockAllocationHelper/DeliveryOrderLinkHelper/ValueStreamHelper/
/// PredictedUsageHelper for the enrichment passes each dataset runs through
/// before being persisted.
///
/// No Quartz.NET job calls any of these methods yet (deferred to Phase 10) —
/// every one is reachable today only via its controller's manual "Refresh
/// Now" trigger, matching this migration's established "cron entry point
/// ported as a callable Helper method only" precedent (8e.2's
/// RunDailySyncAsync). `userId` is the authenticated caller triggering the
/// refresh, not a true system/cron identity — same gap, same reason.
/// </summary>
internal static class PerformanceSyncHelper
{
    private const string RohPlant = "3012";

    // ── SAP fetch wrappers (SapServer's PerformanceController/MrpAnalysisController) ──

    private static async Task<List<SapPerformanceStockRow>> FetchStockAsync(ISapServerClient sap, int userId, CancellationToken ct) =>
        await sap.GetAsync<List<SapPerformanceStockRow>>("api/performance/stock", userId, longRunning: true, ct: ct) ?? [];

    private static async Task<List<SapAgreementRow>> FetchAgreementsAsync(ISapServerClient sap, int userId, int horizonDays, CancellationToken ct)
    {
        var path = QueryHelpers.AddQueryString("api/performance/agreements", "horizonDays", horizonDays.ToString());
        return await sap.GetAsync<List<SapAgreementRow>>(path, userId, longRunning: true, ct: ct) ?? [];
    }

    private static async Task<List<SapInvoiceRow>> FetchInvoicingAsync(ISapServerClient sap, int userId, DateTime from, DateTime to, CancellationToken ct)
    {
        var qs = new Dictionary<string, string?> { ["from"] = IsoDate(from), ["to"] = IsoDate(to) };
        var path = QueryHelpers.AddQueryString("api/performance/invoicing", qs);
        return await sap.GetAsync<List<SapInvoiceRow>>(path, userId, longRunning: true, ct: ct) ?? [];
    }

    private static async Task<List<SapOtifRow>> FetchOtifAsync(ISapServerClient sap, int userId, DateTime from, DateTime to, CancellationToken ct)
    {
        var qs = new Dictionary<string, string?> { ["from"] = IsoDate(from), ["to"] = IsoDate(to) };
        var path = QueryHelpers.AddQueryString("api/performance/otif", qs);
        return await sap.GetAsync<List<SapOtifRow>>(path, userId, longRunning: true, ct: ct) ?? [];
    }

    private static async Task<List<SapTurnsValClassRow>> FetchTurnsValClassAsync(ISapServerClient sap, int userId, CancellationToken ct) =>
        await sap.GetAsync<List<SapTurnsValClassRow>>("api/performance/turns-valclass", userId, longRunning: true, ct: ct) ?? [];

    private static async Task<List<SapValuationClassRow>> FetchValuationClassCatalogAsync(ISapServerClient sap, int userId, CancellationToken ct) =>
        await sap.GetAsync<List<SapValuationClassRow>>("api/performance/turns-valclass/valuation-classes", userId, longRunning: true, ct: ct) ?? [];

    private static async Task<List<SapConsumptionByYearRow>> FetchConsumptionByYearAsync(ISapServerClient sap, int userId, CancellationToken ct) =>
        await sap.GetAsync<List<SapConsumptionByYearRow>>("api/mrp-analysis/consumption-by-year", userId, longRunning: true, ct: ct) ?? [];

    private static async Task<List<SapGoodsReceiptHistoryRow>> FetchGoodsReceiptHistoryAsync(ISapServerClient sap, int userId, string sinceDate, CancellationToken ct)
    {
        var path = QueryHelpers.AddQueryString("api/mrp-analysis/goods-receipt-history", "sinceDate", sinceDate);
        return await sap.GetAsync<List<SapGoodsReceiptHistoryRow>>(path, userId, longRunning: true, ct: ct) ?? [];
    }

    private static string IsoDate(DateTime d) => d.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ");

    // ── Stock + Agreements (log.StockSnapshot / log.AgreementSnapshot) ───

    private static async Task<List<RefreshDatasetOutcome>> SyncStockAndAgreementsAsync(INexusDb nexusDb, INexusOperationsDb opsDb, ISapServerClient sap, int userId, List<SapPerformanceStockRow> stockRows, List<SapAgreementRow> agreementRows, CancellationToken ct)
    {
        using var refreshConn = await nexusDb.CreateConnectionAsync(ct);
        var stockRunId = await PerformanceSnapshotHelper.StartRefreshAsync(refreshConn, "Stock", ct);
        var agreementsRunId = await PerformanceSnapshotHelper.StartRefreshAsync(refreshConn, "Agreements", ct);

        try
        {
            var allocated = StockAllocationHelper.AllocateStock(agreementRows, stockRows).ToList();

            using var opsConn = await opsDb.CreateConnectionAsync(ct);

            // Must run after AllocateStock (needs the raw delivery number for its picked-stock
            // staging-bin match) and before ReplaceAgreementSnapshotAsync (so OriginalDoc/
            // OriginalDocItem are populated before the snapshot write) — see
            // DeliveryOrderLinkHelper's header comment.
            try
            {
                await DeliveryOrderLinkHelper.ResolveDeliveryReferenceDocumentsAsync(opsConn, sap, userId, allocated, ct);
            }
            catch (Exception)
            {
                // Best-effort: a VBFA lookup failure shouldn't block the sync — worst case a
                // handful of freshly-picked lines keep the delivery number until the next
                // successful sync (see DeliveryOrderLinkHelper's own header comment).
            }

            ValueStreamHelper.EnrichWithValueStream(stockRows);
            ValueStreamHelper.EnrichWithValueStream(allocated);

            await PerformanceSnapshotHelper.ReplaceStockSnapshotAsync(opsConn, stockRows, ct);
            await PerformanceSnapshotHelper.CompleteRefreshAsync(refreshConn, stockRunId, stockRows.Count, ct);

            await PerformanceSnapshotHelper.ReplaceAgreementSnapshotAsync(opsConn, allocated, ct);
            await PerformanceSnapshotHelper.CompleteRefreshAsync(refreshConn, agreementsRunId, allocated.Count, ct);

            var todayTotals = ValueStreamHelper.ComputeTodayStockAndPickedTotals(allocated);
            await PerformanceSnapshotHelper.UpsertTodayStockAndPickedAsync(opsConn, todayTotals, ct);

            return [new("Stock", "success", stockRows.Count), new("Agreements", "success", allocated.Count)];
        }
        catch (Exception ex)
        {
            await PerformanceSnapshotHelper.FailRefreshAsync(refreshConn, stockRunId, ex.Message, ct);
            await PerformanceSnapshotHelper.FailRefreshAsync(refreshConn, agreementsRunId, ex.Message, ct);
            return [new("Stock", "failed", Error: ex.Message), new("Agreements", "failed", Error: ex.Message)];
        }
    }

    private static async Task<RefreshDatasetOutcome> SyncInvoicingAsync(INexusDb nexusDb, INexusOperationsDb opsDb, List<SapInvoiceRow> rows, CancellationToken ct)
    {
        using var refreshConn = await nexusDb.CreateConnectionAsync(ct);
        var runId = await PerformanceSnapshotHelper.StartRefreshAsync(refreshConn, "Invoicing", ct);

        try
        {
            ValueStreamHelper.EnrichWithValueStream(rows);
            using var opsConn = await opsDb.CreateConnectionAsync(ct);
            await PerformanceSnapshotHelper.ReplaceInvoiceSnapshotAsync(opsConn, rows, ct);
            await PerformanceSnapshotHelper.RecomputeDailyInvoicedAsync(opsConn, ct);
            await PerformanceSnapshotHelper.CompleteRefreshAsync(refreshConn, runId, rows.Count, ct);
            return new("Invoicing", "success", rows.Count);
        }
        catch (Exception ex)
        {
            await PerformanceSnapshotHelper.FailRefreshAsync(refreshConn, runId, ex.Message, ct);
            return new("Invoicing", "failed", Error: ex.Message);
        }
    }

    private static async Task<RefreshDatasetOutcome> SyncOtifAsync(INexusDb nexusDb, INexusOperationsDb opsDb, List<SapOtifRow> rows, CancellationToken ct)
    {
        using var refreshConn = await nexusDb.CreateConnectionAsync(ct);
        var runId = await PerformanceSnapshotHelper.StartRefreshAsync(refreshConn, "Otif", ct);

        try
        {
            ValueStreamHelper.EnrichWithValueStream(rows);
            using var opsConn = await opsDb.CreateConnectionAsync(ct);
            await PerformanceSnapshotHelper.ReplaceOtifSnapshotAsync(opsConn, rows, ct);
            await PerformanceSnapshotHelper.RecomputeDailyOtifAsync(opsConn, ct);
            await PerformanceSnapshotHelper.CompleteRefreshAsync(refreshConn, runId, rows.Count, ct);
            return new("Otif", "success", rows.Count);
        }
        catch (Exception ex)
        {
            await PerformanceSnapshotHelper.FailRefreshAsync(refreshConn, runId, ex.Message, ct);
            return new("Otif", "failed", Error: ex.Message);
        }
    }

    /// <summary>Runs Stock/Agreements/Invoicing/Otif — the 30-min cron's dataset set, and the manual "Refresh Now" trigger on the Management page. Unlike TurnsValClass/MrpHistory below, Node's own runFullRefresh has no shared-in-flight-run guard, so neither does this port — an overlapping call is a latent, pre-existing risk carried across unchanged, not a regression introduced here.</summary>
    internal static async Task<IReadOnlyList<RefreshDatasetOutcome>> RunFullRefreshAsync(INexusDb nexusDb, INexusOperationsDb opsDb, ISapServerClient sap, int userId, CancellationToken ct)
    {
        var now = DateTime.UtcNow;

        var stockTask = FetchStockAsync(sap, userId, ct);
        var agreementsTask = FetchAgreementsAsync(sap, userId, 365, ct);
        var invoicingTask = FetchInvoicingAsync(sap, userId, now.AddDays(-30), now, ct);
        var otifTask = FetchOtifAsync(sap, userId, now.AddDays(-365), now, ct);

        var results = new List<RefreshDatasetOutcome>();

        List<SapPerformanceStockRow>? stockRows = null;
        List<SapAgreementRow>? agreementRows = null;
        string? stockError = null;
        string? agreementsError = null;

        try { stockRows = await stockTask; } catch (Exception ex) { stockError = ex.Message; }
        try { agreementRows = await agreementsTask; } catch (Exception ex) { agreementsError = ex.Message; }

        if (stockRows is not null && agreementRows is not null)
        {
            results.AddRange(await SyncStockAndAgreementsAsync(nexusDb, opsDb, sap, userId, stockRows, agreementRows, ct));
        }
        else
        {
            if (stockError is not null) results.Add(new("Stock", "failed", Error: stockError));
            if (agreementsError is not null) results.Add(new("Agreements", "failed", Error: agreementsError));
        }

        try { results.Add(await SyncInvoicingAsync(nexusDb, opsDb, await invoicingTask, ct)); }
        catch (Exception ex) { results.Add(new("Invoicing", "failed", Error: ex.Message)); }

        try { results.Add(await SyncOtifAsync(nexusDb, opsDb, await otifTask, ct)); }
        catch (Exception ex) { results.Add(new("Otif", "failed", Error: ex.Message)); }

        return results;
    }

    // ── MM Turns / Valuation Class — separate daily cron, not part of RunFullRefreshAsync ──

    private static async Task<RefreshDatasetOutcome> SyncTurnsValClassAsync(INexusDb nexusDb, INexusOperationsDb opsDb, List<SapTurnsValClassRow> rows, CancellationToken ct)
    {
        using var refreshConn = await nexusDb.CreateConnectionAsync(ct);
        var runId = await PerformanceSnapshotHelper.StartRefreshAsync(refreshConn, "TurnsValClass", ct);

        try
        {
            // Dedupe/attach predicted usage here (not just inside ReplaceTurnsValClassSnapshotAsync,
            // which dedupes again harmlessly) so the RowCount reported below reflects actual
            // Material+Plant rows stored, not the raw SAP row count (inflated for split-valuated
            // materials — see PerformanceSnapshotHelper.DedupeTurnsValClassRows).
            var deduped = PerformanceSnapshotHelper.DedupeTurnsValClassRows(rows);
            foreach (var row in deduped) row.PredictedUsage = PredictedUsageHelper.ComputePredictedUsage(row.ConsumptionHistory36);

            using var opsConn = await opsDb.CreateConnectionAsync(ct);
            await PerformanceSnapshotHelper.ReplaceTurnsValClassSnapshotAsync(opsConn, deduped, ct);
            await PerformanceSnapshotHelper.UpsertForecastAccuracyLogAsync(opsConn, deduped, ct);
            // Lightweight daily append-only trend — ReplaceTurnsValClassSnapshotAsync above is
            // TRUNCATE + reinsert every run, so without this there'd be no record of how
            // stock/value moved day to day.
            await PerformanceSnapshotHelper.UpsertStockValuationHistoryAsync(opsConn, deduped, ct);
            await PerformanceSnapshotHelper.CompleteRefreshAsync(refreshConn, runId, deduped.Count, ct);
            return new("TurnsValClass", "success", deduped.Count);
        }
        catch (Exception ex)
        {
            await PerformanceSnapshotHelper.FailRefreshAsync(refreshConn, runId, ex.Message, ct);
            return new("TurnsValClass", "failed", Error: ex.Message);
        }
    }

    private static async Task<RefreshDatasetOutcome> SyncValuationClassesAsync(INexusDb nexusDb, INexusOperationsDb opsDb, List<SapValuationClassRow> rows, CancellationToken ct)
    {
        using var refreshConn = await nexusDb.CreateConnectionAsync(ct);
        var runId = await PerformanceSnapshotHelper.StartRefreshAsync(refreshConn, "ValuationClasses", ct);

        try
        {
            using var opsConn = await opsDb.CreateConnectionAsync(ct);
            await PerformanceSnapshotHelper.ReplaceValuationClassCatalogAsync(opsConn, rows, ct);
            await PerformanceSnapshotHelper.CompleteRefreshAsync(refreshConn, runId, rows.Count, ct);
            return new("ValuationClasses", "success", rows.Count);
        }
        catch (Exception ex)
        {
            await PerformanceSnapshotHelper.FailRefreshAsync(refreshConn, runId, ex.Message, ct);
            return new("ValuationClasses", "failed", Error: ex.Message);
        }
    }

    // Guards against two overlapping runs — replaceTable() has no transaction/lock of its own
    // (TRUNCATE + batched INSERT, no BCP bulk() available on SQL Server 2005 — see
    // SnapshotTableWriter's header comment), so an overlapping call (the daily cron and a
    // manual "Refresh Now" click landing at the same time) would TRUNCATE rows the other call
    // just inserted. Sharing one in-flight Task means a second caller just awaits the same
    // result instead of racing the first — same shape as Node's own module-level shared-promise
    // guard (turnsValClassRefreshPromise).
    private static Task<IReadOnlyList<RefreshDatasetOutcome>>? _turnsValClassRefreshTask;
    private static readonly object TurnsValClassLock = new();

    internal static Task<IReadOnlyList<RefreshDatasetOutcome>> RunTurnsValClassRefreshAsync(INexusDb nexusDb, INexusOperationsDb opsDb, ISapServerClient sap, int userId, CancellationToken ct)
    {
        lock (TurnsValClassLock)
        {
            if (_turnsValClassRefreshTask is { IsCompleted: false }) return _turnsValClassRefreshTask;

            var task = DoRunTurnsValClassRefreshAsync(nexusDb, opsDb, sap, userId, ct);
            _turnsValClassRefreshTask = task;
            _ = task.ContinueWith(t => { lock (TurnsValClassLock) { if (_turnsValClassRefreshTask == t) _turnsValClassRefreshTask = null; } }, TaskScheduler.Default);
            return task;
        }
    }

    private static async Task<IReadOnlyList<RefreshDatasetOutcome>> DoRunTurnsValClassRefreshAsync(INexusDb nexusDb, INexusOperationsDb opsDb, ISapServerClient sap, int userId, CancellationToken ct)
    {
        var turnsTask = FetchTurnsValClassAsync(sap, userId, ct);
        var valClassTask = FetchValuationClassCatalogAsync(sap, userId, ct);

        var results = new List<RefreshDatasetOutcome>();

        try { results.Add(await SyncTurnsValClassAsync(nexusDb, opsDb, await turnsTask, ct)); }
        catch (Exception ex) { results.Add(new("TurnsValClass", "failed", Error: ex.Message)); }

        try { results.Add(await SyncValuationClassesAsync(nexusDb, opsDb, await valClassTask, ct)); }
        catch (Exception ex) { results.Add(new("ValuationClasses", "failed", Error: ex.Message)); }

        return results;
    }

    // ── MRP Analysis history — weekly, not part of RunFullRefreshAsync or the daily TurnsValClass refresh ──
    // Same shared-in-flight-Task guard as TurnsValClass above, for the same reason (this can
    // also be triggered manually from the MRP Analysis screen's "Refresh Now" button, which
    // could otherwise race the weekly cron).

    private static Task<RefreshDatasetOutcome>? _mrpHistoryRefreshTask;
    private static readonly object MrpHistoryLock = new();

    internal static Task<RefreshDatasetOutcome> RunMrpHistoryRefreshAsync(INexusDb nexusDb, INexusOperationsDb opsDb, ISapServerClient sap, int userId, CancellationToken ct)
    {
        lock (MrpHistoryLock)
        {
            if (_mrpHistoryRefreshTask is { IsCompleted: false }) return _mrpHistoryRefreshTask;

            var task = SyncMrpHistoryAsync(nexusDb, opsDb, sap, userId, ct);
            _mrpHistoryRefreshTask = task;
            _ = task.ContinueWith(t => { lock (MrpHistoryLock) { if (_mrpHistoryRefreshTask == t) _mrpHistoryRefreshTask = null; } }, TaskScheduler.Default);
            return task;
        }
    }

    /// <summary>Goods-receipt history is bounded to the same ~5-year window BuildConsumptionHistoryRequest already casts on the SapServer side — without this, MSEG/EKKO have no natural cutoff and would pull receipts back to whenever real SAP history begins.</summary>
    private static string MrpHistorySinceDate() => $"01.01.{DateTime.UtcNow.Year - 4}";

    private static async Task<RefreshDatasetOutcome> SyncMrpHistoryAsync(INexusDb nexusDb, INexusOperationsDb opsDb, ISapServerClient sap, int userId, CancellationToken ct)
    {
        using var refreshConn = await nexusDb.CreateConnectionAsync(ct);
        var runId = await PerformanceSnapshotHelper.StartRefreshAsync(refreshConn, "MrpAnalysisHistory", ct);

        try
        {
            var sinceDate = MrpHistorySinceDate();
            using var opsConn = await opsDb.CreateConnectionAsync(ct);

            var consumptionTask = FetchConsumptionByYearAsync(sap, userId, ct);
            var receiptTask = FetchGoodsReceiptHistoryAsync(sap, userId, sinceDate, ct);
            var rohMaterialsTask = PerformanceSnapshotHelper.ListRohMaterialsAsync(opsConn, ct);

            var consumptionRows = await consumptionTask;
            var receiptRows = await receiptTask;
            var rohMaterials = await rohMaterialsTask;

            // MRP Analysis exists to forecast what raw material to buy — finished/semi-finished
            // consumption and receipts aren't useful here and just multiply the amount of history
            // synced/stored/rendered for no benefit.
            var rohConsumptionRows = consumptionRows.Where(r => rohMaterials.Contains(r.Material)).ToList();
            var rohReceiptRows = receiptRows.Where(r => rohMaterials.Contains(r.Material)).ToList();

            // Plant is always 3012 for this app — SapServer's MRP Analysis endpoints don't return
            // it themselves since every RFC read behind them is already plant-filtered server-side.
            await PerformanceSnapshotHelper.UpsertMaterialConsumptionHistoryAsync(opsConn,
                rohConsumptionRows.Select(r => (r.Material, RohPlant, r.FiscalYear, r.Qty)).ToList(), ct);

            await PerformanceSnapshotHelper.UpsertMaterialReceiptHistoryAsync(opsConn,
                rohReceiptRows.Select(r => (r.Material, RohPlant, r.Vendor ?? "", r.Year, r.Qty, r.Uom)).ToList(), ct);

            var total = rohConsumptionRows.Count + rohReceiptRows.Count;
            await PerformanceSnapshotHelper.CompleteRefreshAsync(refreshConn, runId, total, ct);
            return new("MrpAnalysisHistory", "success", total);
        }
        catch (Exception ex)
        {
            await PerformanceSnapshotHelper.FailRefreshAsync(refreshConn, runId, ex.Message, ct);
            return new("MrpAnalysisHistory", "failed", Error: ex.Message);
        }
    }
}
