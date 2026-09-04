using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// SAP goods-receipt sync + live-stock refresh for the Vendor Consignment
/// Tracker — Logistics Sub-phase 8e.2. Port of routes/consignment.js's
/// fetchSapVendorGr/mapGrRows/refreshConsignmentStockSnapshot/
/// runConsignmentSync. Calls SapServer's real, already-existing
/// api/consignment/gr and api/consignment/stock endpoints directly via
/// ISapServerClient (SapServer.ConsignmentController — confirmed by
/// reading that controller directly, not assumed).
///
/// `RunDailySyncAsync` is the cron entry point (Node's runConsignmentSync,
/// wired to server.js's 06:20 slot) — no Quartz.NET jobs have been wired up
/// anywhere in this migration yet (deferred to Phase 10's cross-cutting
/// closeout, per the migration plan), so this is ported as a callable
/// Helper method only, ready for that phase to schedule, matching every
/// other not-yet-scheduled cron entry point in this app so far.
/// </summary>
internal static class ConsignmentSapSyncHelper
{
    /// <summary>
    /// GET /api/consignment/gr uses SapServer's [FromUri] (query-string)
    /// binding, not a JSON body — unlike most SapServerClient GET calls in
    /// this app (see ISapServerClient's own doc comment for the handful of
    /// SapServer endpoints that DO read a body on GET), so the query
    /// string is built directly into the path here instead of passed via
    /// GetAsync's optional body parameter.
    /// </summary>
    internal static async Task<IReadOnlyList<ConsignmentGrRow>> FetchVendorGrAsync(ISapServerClient sap, string sapVendorNumber, string? sinceDate, int userId, CancellationToken ct)
    {
        var path = $"api/consignment/gr?sapVendorNumber={Uri.EscapeDataString(sapVendorNumber)}"
            + (sinceDate is not null ? $"&sinceDate={Uri.EscapeDataString(sinceDate)}" : "");
        // 3-minute allowance — a first-ever sync for a vendor with years of
        // GR history (no sinceDate floor on a normal sync call) legitimately
        // exceeded SapServerOptions' own default 30s timeout in production.
        return await sap.GetAsync<List<ConsignmentGrRow>>(path, userId, longRunning: true, ct: ct) ?? [];
    }

    /// <summary>Live consignment stock (MKOL SLABS), plant-wide — the same unfiltered scan already proven for MRP, so this can legitimately take several minutes (10-minute allowance, matching Node's own client timeout for this exact call).</summary>
    internal static async Task<IReadOnlyDictionary<string, decimal>> FetchConsignmentStockAsync(ISapServerClient sap, int userId, CancellationToken ct) =>
        await sap.GetAsync<Dictionary<string, decimal>>("api/consignment/stock", userId, longRunning: true, ct: ct) ?? new Dictionary<string, decimal>();

    internal static async Task<ConsignmentStockSnapshotMeta> RefreshStockSnapshotAsync(INexusOperationsDb db, ISapServerClient sap, int userId, CancellationToken ct)
    {
        var stock = await FetchConsignmentStockAsync(sap, userId, ct);
        return await ConsignmentTrackerHelper.ReplaceStockSnapshotAsync(db, stock, ct);
    }

    /// <summary>SAP GR sync for one vendor — pulls fresh goods-receipt lines, upserts any not already known, then applies the reversal-cancellation parity-walk. Blocked with a clear error if SapVendorNumber isn't set yet, matching every other elevated SAP call's "no SAP identifier configured" guard in this app.</summary>
    internal static async Task<ConsignmentSyncResult> SyncVendorAsync(INexusOperationsDb db, ISapServerClient sap, long vendorId, int userId, CancellationToken ct)
    {
        var vendor = await ConsignmentTrackerHelper.GetVendorAsync(db, vendorId, ct)
            ?? throw new NexusNotFoundException("Vendor not found.");
        if (string.IsNullOrWhiteSpace(vendor.SapVendorNumber))
            throw new NexusUnprocessableEntityException(
                $"{vendor.VendorName} has no SAP vendor number set — add one on the Vendor Master Data page before syncing GR data from SAP.");

        var grRows = await FetchVendorGrAsync(sap, vendor.SapVendorNumber, null, userId, ct);
        var mapped = MapGrRows(grRows);
        var inserted = await ConsignmentTrackerHelper.UpsertDeliveriesFromSapAsync(db, vendorId, mapped, ct);
        var cancellations = await ConsignmentTrackerHelper.ApplyReversalCancellationsAsync(db, vendorId, ct);

        return new ConsignmentSyncResult(grRows.Count, inserted, cancellations.Zeroed.Count, cancellations.NeedsReview);
    }

    private static List<SapDeliveryRow> MapGrRows(IReadOnlyList<ConsignmentGrRow> rows) =>
        rows.Select(r => new SapDeliveryRow(
            r.Material, r.MaterialDocument, r.MaterialDocItem, r.Quantity, NullIfEmpty(r.Uom), NullIfEmpty(r.InvoiceNumber),
            ParseSapDate(r.DocumentDate), ParseSapDate(r.PostingDate), NullIfEmpty(r.ReversalOfMaterialDocument), NullIfEmpty(r.ReversalOfMaterialDocItem)))
        .ToList();

    /// <summary>SAP dd.mm.yyyy -> DateTime? — same GUI-format date convention as everywhere else this app parses ZRFC_READ_TABLES output.</summary>
    private static DateTime? ParseSapDate(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var m = System.Text.RegularExpressions.Regex.Match(raw.Trim(), @"^(\d{2})\.(\d{2})\.(\d{4})$");
        if (!m.Success) return null;
        return new DateTime(int.Parse(m.Groups[3].Value), int.Parse(m.Groups[2].Value), int.Parse(m.Groups[1].Value), 0, 0, 0, DateTimeKind.Utc);
    }

    private static string? NullIfEmpty(string? value) => string.IsNullOrEmpty(value) ? null : value;

    /// <summary>
    /// Pulls fresh GR data for every active consignment vendor with a
    /// SapVendorNumber set, then refreshes the stock snapshot once,
    /// deliberately AFTER the per-vendor GR loop finishes (sequential, not
    /// concurrent, so it doesn't compete with the GR pulls for a SapServer
    /// connection-pool worker slot). A vendor missing a SapVendorNumber is
    /// skipped, not an error — same as SyncVendorAsync's own guard.
    /// </summary>
    internal static async Task<DailySyncResult> RunDailySyncAsync(INexusOperationsDb db, ISapServerClient sap, int userId, CancellationToken ct)
    {
        var vendors = await ConsignmentTrackerHelper.ListVendorsAsync(db, ct);
        var results = new List<VendorSyncOutcome>();

        foreach (var vendor in vendors)
        {
            if (!vendor.Active || string.IsNullOrWhiteSpace(vendor.SapVendorNumber))
            {
                results.Add(new VendorSyncOutcome(vendor.VendorName, true, null, null, null, null, null));
                continue;
            }
            try
            {
                var outcome = await SyncVendorAsync(db, sap, vendor.VendorId, userId, ct);
                results.Add(new VendorSyncOutcome(vendor.VendorName, false, outcome.Pulled, outcome.Inserted, outcome.CancellationsZeroed, outcome.NeedsReview.Count, null));
            }
            catch (Exception ex)
            {
                results.Add(new VendorSyncOutcome(vendor.VendorName, false, null, null, null, null, ex.Message));
            }
        }

        StockSnapshotSyncOutcome stockOutcome;
        try
        {
            var meta = await RefreshStockSnapshotAsync(db, sap, userId, ct);
            stockOutcome = new StockSnapshotSyncOutcome(meta.MaterialCount, null);
        }
        catch (Exception ex)
        {
            stockOutcome = new StockSnapshotSyncOutcome(null, ex.Message);
        }

        return new DailySyncResult(results, stockOutcome);
    }
}
