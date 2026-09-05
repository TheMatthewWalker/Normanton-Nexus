using System.Data;
using Dapper;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Snapshot/history table writes backing the Performance refresh-orchestration
/// jobs — Logistics Sub-phase 8b.6. Port of routes/performancesql.js's
/// replaceStockSnapshot/replaceAgreementSnapshot/replaceInvoiceSnapshot/
/// replaceOtifSnapshot/dedupeTurnsValClassRows/replaceTurnsValClassSnapshot/
/// replaceValuationClassCatalog/upsertStockValuationHistory/
/// upsertForecastAccuracyLog/upsertMaterialConsumptionHistory/
/// upsertMaterialReceiptHistory/listRohMaterials/startRefresh/completeRefresh/
/// failRefresh/recomputeDailyInvoiced/recomputeDailyOtif/
/// upsertTodayStockAndPicked/getCachedDeliveryOrderLinks/
/// insertDeliveryOrderLinksIfMissing, all built on SnapshotTableWriter's
/// generic Replace/Upsert engines.
/// </summary>
internal static class PerformanceSnapshotHelper
{
    // ── Snapshot replace (TRUNCATE + reinsert) ───────────────────────────
    // Every replace call filters out rows with no ValueStream mapping first — mirrors
    // replaceTable()'s own "filter unmapped ValueStreams, but only for tables that carry
    // that column" behavior (TurnsValClassSnapshot/ValuationClassCatalog have no such column
    // and are never filtered).

    internal static Task ReplaceStockSnapshotAsync(IDbConnection connection, IReadOnlyList<SapPerformanceStockRow> rows, CancellationToken ct)
    {
        IReadOnlyList<SnapshotTableWriter.Column<SapPerformanceStockRow>> columns =
        [
            new("Material", r => r.Material, 18),
            new("Batch", r => r.Batch, 10),
            new("StorageBin", r => r.StorageBin, 10),
            new("StorageType", r => r.StorageType, 3),
            new("TotalQty", r => r.TotalQty),
            new("AvailableQty", r => r.AvailableQty),
            new("StorageLocation", r => r.StorageLocation, 4),
            new("PackagingMaterial", r => r.PackagingMaterial, 40),
            new("ValueStream", r => r.ValueStream, 8),
        ];
        return SnapshotTableWriter.ReplaceAsync(connection, "log.StockSnapshot", columns, rows.Where(r => r.ValueStream is not null).ToList(), ct);
    }

    internal static Task ReplaceAgreementSnapshotAsync(IDbConnection connection, IReadOnlyList<SapAgreementRow> rows, CancellationToken ct)
    {
        IReadOnlyList<SnapshotTableWriter.Column<SapAgreementRow>> columns =
        [
            new("ProfitCentre", r => r.ProfitCentre, 10),
            new("Plant", r => r.Plant, 4),
            new("Mid", r => r.Mid, 48),
            new("MrpController", r => r.MrpController, 3),
            new("Material", r => r.Material, 18),
            new("MaterialText", r => r.MaterialText, 40),
            new("ValueStream", r => r.ValueStream, 8),
            new("OnHandQty", r => r.OnHandQty),
            new("Uom", r => r.Uom, 3),
            new("StandardPrice", r => r.StandardPrice),
            new("LocalCurrency", r => r.LocalCurrency, 5),
            new("Customer", r => r.Customer, 10),
            new("CustomerGroup", r => r.CustomerGroup, 10),
            new("CustomerName", r => r.CustomerName, 35),
            new("OrderType", r => r.OrderType, 4),
            new("ReferenceDocument", r => r.ReferenceDocument, 10),
            new("Item", r => r.Item, 6),
            new("OriginalDoc", r => r.OriginalDoc, 10),
            new("OriginalDocItem", r => r.OriginalDocItem, 6),
            new("CustomerPo", r => r.CustomerPo, 20),
            new("CustomerMaterial", r => r.CustomerMaterial, 35),
            new("CustomerReference", r => r.CustomerReference, 30),
            new("UnloadingPoint", r => r.UnloadingPoint, 25),
            new("RequestDate", r => r.RequestDate),
            new("Week", r => r.Week, 6),
            new("Period", r => r.Period, 7),
            new("OrderQty", r => r.OrderQty),
            // Amount is populated from LocalAmount (GBP/home-currency), not the raw document-
            // currency amount — see performancesql.js's own comment: the document amount isn't
            // used anywhere in this app, and every query already reads from Amount.
            new("Amount", r => r.LocalAmount),
            new("Currency", r => r.Currency, 5),
            new("DockStockAllocated", r => r.DockStockAllocated),
            new("PickedStockAllocated", r => r.PickedStockAllocated),
        ];
        return SnapshotTableWriter.ReplaceAsync(connection, "log.AgreementSnapshot", columns, rows.Where(r => r.ValueStream is not null).ToList(), ct);
    }

    internal static Task ReplaceInvoiceSnapshotAsync(IDbConnection connection, IReadOnlyList<SapInvoiceRow> rows, CancellationToken ct)
    {
        IReadOnlyList<SnapshotTableWriter.Column<SapInvoiceRow>> columns =
        [
            new("Plant", r => r.Plant, 4),
            new("SalesOrg", r => r.SalesOrg, 4),
            new("InvoiceDate", r => r.InvoiceDate),
            new("InvoiceType", r => r.InvoiceType, 4),
            new("InvoiceNumber", r => r.InvoiceNumber, 10),
            new("DeliveryNote", r => r.DeliveryNote, 10),
            new("SalesAgreement", r => r.SalesAgreement, 10),
            new("SalesItem", r => r.SalesItem, 6),
            new("CustomerPo", r => r.CustomerPo, 35),
            new("CustomerGroup", r => r.CustomerGroup, 10),
            new("Customer", r => r.Customer, 10),
            new("Material", r => r.Material, 18),
            new("MaterialText", r => r.MaterialText, 40),
            new("Quantity", r => r.Quantity),
            new("DocumentAmount", r => r.DocumentAmount),
            new("LocalAmount", r => r.LocalAmount),
            new("Currency", r => r.Currency, 5),
            new("ProfitCentre", r => r.ProfitCentre, 10),
            new("Period", r => r.Period, 7),
            new("ValueStream", r => r.ValueStream, 8),
        ];
        return SnapshotTableWriter.ReplaceAsync(connection, "log.InvoiceSnapshot", columns, rows.Where(r => r.ValueStream is not null).ToList(), ct);
    }

    internal static Task ReplaceOtifSnapshotAsync(IDbConnection connection, IReadOnlyList<SapOtifRow> rows, CancellationToken ct)
    {
        IReadOnlyList<SnapshotTableWriter.Column<SapOtifRow>> columns =
        [
            new("Customer", r => r.Customer, 10),
            new("CustomerName", r => r.CustomerName, 35),
            new("Plant", r => r.Plant, 4),
            new("ProfitCentre", r => r.ProfitCentre, 10),
            new("Material", r => r.Material, 18),
            new("MaterialText", r => r.MaterialText, 40),
            new("Delivery", r => r.Delivery, 10),
            new("DeliveryDate", r => r.DeliveryDate),
            new("DeliveryQty", r => r.DeliveryQty),
            new("Uom", r => r.Uom, 3),
            new("TargetDate", r => r.TargetDate),
            new("TargetQty", r => r.TargetQty),
            new("QtyClass", r => r.QtyClass, 4),
            new("DateClass", r => r.DateClass, 4),
            new("OnTime", r => r.OnTime),
            new("ValueStream", r => r.ValueStream, 8),
        ];
        return SnapshotTableWriter.ReplaceAsync(connection, "log.OtifSnapshot", columns, rows.Where(r => r.ValueStream is not null).ToList(), ct);
    }

    // ── MM Turns / Valuation Class ────────────────────────────────────────

    /// <summary>
    /// SAP's MBEW (valuation) table carries one row per Material+Plant+ValuationType — for
    /// split-valuated materials that's more than one row for the same Material+Plant, which
    /// collide against PK_TurnsValClassSnapshot. StockQty/StockValue/BookValue are per-
    /// valuation-type and must be summed to get the true material+plant total, with UnitPrice
    /// recomputed from the summed totals. ConsignmentQty is NOT summed (left exactly as the
    /// first-seen row carries it) — unlike MBEW, MKOL isn't split by valuation type at all,
    /// so summing across duplicates would double/triple-count real consignment stock.
    /// </summary>
    internal static IReadOnlyList<SapTurnsValClassRow> DedupeTurnsValClassRows(IReadOnlyList<SapTurnsValClassRow> rows)
    {
        var map = new Dictionary<string, SapTurnsValClassRow>();

        foreach (var row in rows)
        {
            var key = $"{row.Material}|{row.Plant}";
            if (!map.TryGetValue(key, out var existing))
            {
                map[key] = row;
                continue;
            }

            existing.StockQty += row.StockQty;
            existing.StockValue += row.StockValue;
            existing.BookValue += row.BookValue;
            existing.UnitPrice = existing.StockQty > 0 ? existing.StockValue / existing.StockQty : existing.UnitPrice;
        }

        return map.Values.ToList();
    }

    internal static Task ReplaceTurnsValClassSnapshotAsync(IDbConnection connection, IReadOnlyList<SapTurnsValClassRow> rows, CancellationToken ct)
    {
        var deduped = DedupeTurnsValClassRows(rows);

        List<SnapshotTableWriter.Column<SapTurnsValClassRow>> columns =
        [
            new("Material", r => r.Material, 18),
            new("Plant", r => r.Plant, 4),
            new("MaterialText", r => r.MaterialText, 40),
            new("CreatedDate", r => r.CreatedDate),
            new("MaterialType", r => r.MaterialType, 4),
            new("Uom", r => r.Uom, 3),
            new("ProfitCentre", r => r.ProfitCentre, 10),
            new("DeletionFlag", r => r.DeletionFlag),
            new("AbcIndicator", r => r.AbcIndicator, 1),
            new("PurchasingGroup", r => r.PurchasingGroup, 3),
            new("MrpController", r => r.MrpController, 3),
            new("ValuationClass", r => r.ValuationClass, 4),
            new("LotSizeProcedure", r => r.LotSizeProcedure, 2),
            new("PlanningTimeFence", r => r.PlanningTimeFence),
            new("GrProcessingTime", r => r.GrProcessingTime),
            new("TotalReplenishmentTime", r => r.TotalReplenishmentTime),
            new("SafetyStock", r => r.SafetyStock),
            new("MinLotSize", r => r.MinLotSize),
            new("MaxLotSize", r => r.MaxLotSize),
            new("FixedLotSize", r => r.FixedLotSize),
            new("RoundingValue", r => r.RoundingValue),
            new("SpecialProcurementType", r => r.SpecialProcurementType, 2),
            new("PlannedDeliveryTime", r => r.PlannedDeliveryTime),
            new("StockQty", r => r.StockQty),
            new("ConsignmentQty", r => r.ConsignmentQty),
            new("StockValue", r => r.StockValue),
            new("UnitPrice", r => r.UnitPrice),
            new("BookValue", r => r.BookValue),
        ];

        // History{M12..M00}/Forecast{M12..M00}/Predicted{M12..M00} — 13 columns each, i=0 -> M12
        // (oldest), i=12 -> M00 (current), matching each array's own index orientation exactly
        // (see SapTurnsValClassRow's own doc comment).
        for (var i = 0; i <= 12; i++)
        {
            var suffix = (12 - i).ToString("D2");
            var idx = i;
            columns.Add(new SnapshotTableWriter.Column<SapTurnsValClassRow>($"HistoryM{suffix}", r => idx < r.ConsumptionHistory.Length ? r.ConsumptionHistory[idx] : (decimal?)null));
        }
        for (var i = 0; i <= 12; i++)
        {
            var suffix = (12 - i).ToString("D2");
            var idx = i;
            columns.Add(new SnapshotTableWriter.Column<SapTurnsValClassRow>($"ForecastM{suffix}", r => idx < r.DemandForecast.Length ? r.DemandForecast[idx] : (decimal?)null));
        }
        for (var i = 0; i <= 12; i++)
        {
            var suffix = (12 - i).ToString("D2");
            var idx = i;
            columns.Add(new SnapshotTableWriter.Column<SapTurnsValClassRow>($"PredictedM{suffix}", r => idx < r.PredictedUsage.Length ? r.PredictedUsage[idx] : (decimal?)null));
        }

        columns.AddRange(
        [
            new("LastReceiptDate", r => r.LastReceiptDate),
            new("LastGoodsIssueDate", r => r.LastGoodsIssueDate),
            new("LastConsumptionDate", r => r.LastConsumptionDate),
            new("LastGoodsMovementDate", r => r.LastGoodsMovementDate),
            new("StockTurns", r => r.StockTurns),
            new("DaysInStock", r => r.DaysInStock),
            new("DailyRequirementValue", r => r.DailyRequirementValue),
            new("TurnoverCategory", r => r.TurnoverCategory, 30),
            new("Warning", r => r.Warning, 200),
        ]);

        return SnapshotTableWriter.ReplaceAsync(connection, "log.TurnsValClassSnapshot", columns, deduped, ct);
    }

    internal static Task ReplaceValuationClassCatalogAsync(IDbConnection connection, IReadOnlyList<SapValuationClassRow> rows, CancellationToken ct)
    {
        IReadOnlyList<SnapshotTableWriter.Column<SapValuationClassRow>> columns =
        [
            new("ValuationClass", r => r.ValuationClass, 4),
            new("MaterialType", r => r.MaterialType, 4),
            new("AccountRef", r => r.AccountRef, 4),
            new("Description", r => r.Description, 40),
        ];
        return SnapshotTableWriter.ReplaceAsync(connection, "log.ValuationClassCatalog", columns, rows, ct);
    }

    // ── Append-only history tables ────────────────────────────────────────

    private sealed record StockValuationHistoryRow(string Material, string Plant, DateTime SnapshotDate, string? MaterialType, decimal StockQty, decimal StockValue, decimal ConsignmentQty);

    /// <summary>Keyed on SnapshotDate = today at UTC midnight, so re-running the sync again on the same day updates today's row in place rather than creating a duplicate — one row per material per plant per calendar day, forever. Deliberately narrow columns, kept lightweight on purpose.</summary>
    internal static Task UpsertStockValuationHistoryAsync(IDbConnection connection, IReadOnlyList<SapTurnsValClassRow> rows, CancellationToken ct)
    {
        var snapshotDate = DateTime.UtcNow.Date;
        var historyRows = rows.Select(r => new StockValuationHistoryRow(r.Material, r.Plant, snapshotDate, r.MaterialType, r.StockQty, r.StockValue, r.ConsignmentQty)).ToList();

        IReadOnlyList<SnapshotTableWriter.Column<StockValuationHistoryRow>> keyColumns =
        [
            new("Material", r => r.Material, 18),
            new("Plant", r => r.Plant, 4),
            new("SnapshotDate", r => r.SnapshotDate),
        ];
        IReadOnlyList<SnapshotTableWriter.Column<StockValuationHistoryRow>> columns =
        [
            new("MaterialType", r => r.MaterialType, 4),
            new("StockQty", r => r.StockQty),
            new("StockValue", r => r.StockValue),
            new("ConsignmentQty", r => r.ConsignmentQty),
        ];
        return SnapshotTableWriter.UpsertAsync(connection, "log.StockValuationHistory", keyColumns, columns, historyRows, ct);
    }

    private sealed record ForecastAccuracyForecastRow(string Material, string Plant, DateTime TargetMonth, decimal SapDemandQty, decimal PredictedQty);
    private sealed record ForecastAccuracyActualRow(string Material, string Plant, DateTime TargetMonth, decimal ActualQty);

    /// <summary>
    /// Forward window (k = 0..12, current month through +12 months): upserts SapDemandQty/
    /// PredictedQty. k=1..12 are freely overwritten every day, refining the projection as the
    /// target month approaches; k=0 (the current month) is written insert-only — once a row
    /// exists for it, later runs that same month leave it alone, freezing it at whatever the
    /// forecast was on the first successful sync after the month started. Backward window
    /// (j = 0..2, current month through 2 months back only): upserts ActualQty from
    /// consumption history — once a month has fully closed its actual consumption doesn't
    /// change, so there's no value re-writing it every day forever.
    /// </summary>
    internal static async Task UpsertForecastAccuracyLogAsync(IDbConnection connection, IReadOnlyList<SapTurnsValClassRow> rows, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var thisMonth = new DateTime(now.Year, now.Month, 1, 0, 0, 0, DateTimeKind.Utc);

        var currentMonthRows = new List<ForecastAccuracyForecastRow>();
        var futureMonthRows = new List<ForecastAccuracyForecastRow>();
        var actualRows = new List<ForecastAccuracyActualRow>();

        foreach (var row in rows)
        {
            for (var k = 0; k <= 12; k++)
            {
                var forecastRow = new ForecastAccuracyForecastRow(
                    row.Material, row.Plant, thisMonth.AddMonths(k),
                    k < row.DemandForecast.Length ? row.DemandForecast[k] : 0m,
                    k < row.PredictedUsage.Length ? row.PredictedUsage[k] : 0m);
                (k == 0 ? currentMonthRows : futureMonthRows).Add(forecastRow);
            }

            // ConsumptionHistory index 12 = current month, index (12-j) = j months back.
            for (var j = 0; j <= 2; j++)
            {
                var idx = 12 - j;
                if (idx < 0) continue;
                actualRows.Add(new ForecastAccuracyActualRow(row.Material, row.Plant, thisMonth.AddMonths(-j), idx < row.ConsumptionHistory.Length ? row.ConsumptionHistory[idx] : 0m));
            }
        }

        IReadOnlyList<SnapshotTableWriter.Column<ForecastAccuracyForecastRow>> keyColumns =
        [
            new("Material", r => r.Material, 18),
            new("Plant", r => r.Plant, 4),
            new("TargetMonth", r => r.TargetMonth),
        ];
        IReadOnlyList<SnapshotTableWriter.Column<ForecastAccuracyForecastRow>> forecastColumns =
        [
            new("SapDemandQty", r => r.SapDemandQty),
            new("PredictedQty", r => r.PredictedQty),
        ];

        await SnapshotTableWriter.UpsertAsync(connection, "log.ForecastAccuracyLog", keyColumns, forecastColumns, futureMonthRows, ct);
        await SnapshotTableWriter.UpsertAsync(connection, "log.ForecastAccuracyLog", keyColumns, forecastColumns, currentMonthRows, ct, insertOnly: true);

        IReadOnlyList<SnapshotTableWriter.Column<ForecastAccuracyActualRow>> actualKeyColumns =
        [
            new("Material", r => r.Material, 18),
            new("Plant", r => r.Plant, 4),
            new("TargetMonth", r => r.TargetMonth),
        ];
        IReadOnlyList<SnapshotTableWriter.Column<ForecastAccuracyActualRow>> actualColumns = [new("ActualQty", r => r.ActualQty)];
        await SnapshotTableWriter.UpsertAsync(connection, "log.ForecastAccuracyLog", actualKeyColumns, actualColumns, actualRows, ct);
    }

    // ── MRP Analysis history (log.MaterialConsumptionHistory / log.MaterialReceiptHistory) ──

    internal static Task UpsertMaterialConsumptionHistoryAsync(IDbConnection connection, IReadOnlyList<(string Material, string Plant, int FiscalYear, decimal ConsumedQty)> rows, CancellationToken ct)
    {
        IReadOnlyList<SnapshotTableWriter.Column<(string Material, string Plant, int FiscalYear, decimal ConsumedQty)>> keyColumns =
        [
            new("Material", r => r.Material, 18),
            new("Plant", r => r.Plant, 4),
            new("FiscalYear", r => r.FiscalYear),
        ];
        IReadOnlyList<SnapshotTableWriter.Column<(string Material, string Plant, int FiscalYear, decimal ConsumedQty)>> columns = [new("ConsumedQty", r => r.ConsumedQty)];
        return SnapshotTableWriter.UpsertAsync(connection, "log.MaterialConsumptionHistory", keyColumns, columns, rows, ct);
    }

    /// <summary>VendorId is resolved here (not by the caller) against log.Vendor.SapVendorNumber, one lookup shared across the whole batch — left null when no matching vendor exists yet in Nexus (the row is still kept, keyed by SapVendorNumber, rather than dropped).</summary>
    internal static async Task UpsertMaterialReceiptHistoryAsync(IDbConnection connection, IReadOnlyList<(string Material, string Plant, string SapVendorNumber, int FiscalYear, decimal ReceivedQty, string? Uom)> rows, CancellationToken ct)
    {
        if (rows.Count == 0) return;

        var vendorRows = await connection.QueryAsync<(long VendorId, string SapVendorNumber)>(new CommandDefinition(
            "SELECT VendorId, SapVendorNumber FROM log.Vendor WHERE SapVendorNumber IS NOT NULL", cancellationToken: ct));
        var vendorIdByNumber = vendorRows.ToDictionary(v => v.SapVendorNumber, v => (long?)v.VendorId);

        var withVendorId = rows.Select(r => (r.Material, r.Plant, r.SapVendorNumber, r.FiscalYear, r.ReceivedQty, r.Uom, VendorId: vendorIdByNumber.GetValueOrDefault(r.SapVendorNumber))).ToList();

        IReadOnlyList<SnapshotTableWriter.Column<(string Material, string Plant, string SapVendorNumber, int FiscalYear, decimal ReceivedQty, string? Uom, long? VendorId)>> keyColumns =
        [
            new("Material", r => r.Material, 18),
            new("Plant", r => r.Plant, 4),
            new("SapVendorNumber", r => r.SapVendorNumber, 10),
            new("FiscalYear", r => r.FiscalYear),
        ];
        IReadOnlyList<SnapshotTableWriter.Column<(string Material, string Plant, string SapVendorNumber, int FiscalYear, decimal ReceivedQty, string? Uom, long? VendorId)>> columns =
        [
            new("VendorId", r => r.VendorId),
            new("ReceivedQty", r => r.ReceivedQty),
            new("Uom", r => r.Uom, 3),
        ];
        await SnapshotTableWriter.UpsertAsync(connection, "log.MaterialReceiptHistory", keyColumns, columns, withVendorId, ct);
    }

    internal static async Task<IReadOnlyCollection<string>> ListRohMaterialsAsync(IDbConnection connection, CancellationToken ct)
    {
        var materials = await connection.QueryAsync<string>(new CommandDefinition(
            "SELECT Material FROM log.TurnsValClassSnapshot WHERE MaterialType = 'ROH'", cancellationToken: ct));
        return materials.ToHashSet();
    }

    // ── Refresh log (dbo.RefreshLog, Nexus database) ─────────────────────

    internal static async Task<long> StartRefreshAsync(IDbConnection connection, string datasetName, CancellationToken ct) =>
        await connection.QuerySingleAsync<long>(new CommandDefinition("""
            INSERT INTO dbo.RefreshLog (DatasetName, StartedAtUtc, Status)
            OUTPUT INSERTED.RunId
            VALUES (@datasetName, GETUTCDATE(), 'Running')
            """, new { datasetName }, cancellationToken: ct));

    internal static Task CompleteRefreshAsync(IDbConnection connection, long runId, int totalRows, CancellationToken ct) =>
        connection.ExecuteAsync(new CommandDefinition("""
            UPDATE dbo.RefreshLog
            SET CompletedAtUtc = GETUTCDATE(), TotalRows = @totalRows, Status = 'Success'
            WHERE RunId = @runId
            """, new { runId, totalRows }, cancellationToken: ct));

    internal static Task FailRefreshAsync(IDbConnection connection, long runId, string? message, CancellationToken ct)
    {
        var truncated = (message ?? "").Length > 4000 ? message![..4000] : message;
        return connection.ExecuteAsync(new CommandDefinition("""
            UPDATE dbo.RefreshLog
            SET CompletedAtUtc = GETUTCDATE(), Status = 'Failed', ErrorMessage = @truncated
            WHERE RunId = @runId
            """, new { runId, truncated }, cancellationToken: ct));
    }

    // ── Daily fact table (log.DailyPerformance) ──────────────────────────
    // No temp tables and no transactions — same reasoning as replaceTable() above. The number
    // of distinct MetricDate+ValueStream combinations is small (hundreds at most), so one
    // round-trip per distinct row (IF EXISTS UPDATE / ELSE INSERT) is perfectly fine here.

    internal static async Task RecomputeDailyInvoicedAsync(IDbConnection connection, CancellationToken ct)
    {
        // LEFT JOIN .. IS NULL excludes consignment customers — we ship to them but don't
        // invoice until they consume it, so their InvoiceSnapshot rows must not inflate the
        // daily invoiced fact table (see sql/migrate_consignment_customers.sql).
        var rows = await connection.QueryAsync<(DateTime MetricDate, string ValueStream, decimal InvoicedValue)>(new CommandDefinition("""
            SELECT
              CAST(CONVERT(VARCHAR(8), i.InvoiceDate, 112) AS DATETIME) AS MetricDate,
              i.ValueStream AS ValueStream,
              SUM(i.LocalAmount) AS InvoicedValue
            FROM log.InvoiceSnapshot i
            LEFT JOIN log.ConsignmentCustomer cc ON cc.Customer = i.Customer
            WHERE i.InvoiceType <> 'F5' AND cc.Customer IS NULL
            GROUP BY CONVERT(VARCHAR(8), i.InvoiceDate, 112), i.ValueStream
            """, cancellationToken: ct));

        foreach (var row in rows)
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                IF EXISTS (SELECT 1 FROM log.DailyPerformance WHERE MetricDate = @MetricDate AND ValueStream = @ValueStream)
                  UPDATE log.DailyPerformance SET InvoicedValue = @InvoicedValue
                  WHERE MetricDate = @MetricDate AND ValueStream = @ValueStream
                ELSE
                  INSERT INTO log.DailyPerformance (MetricDate, ValueStream, InvoicedValue)
                  VALUES (@MetricDate, @ValueStream, @InvoicedValue)
                """, row, cancellationToken: ct));
        }
    }

    internal static async Task RecomputeDailyOtifAsync(IDbConnection connection, CancellationToken ct)
    {
        var rows = await connection.QueryAsync<(DateTime MetricDate, string ValueStream, int OtifOnTimeCount, int OtifTotalCount)>(new CommandDefinition("""
            SELECT
              CAST(CONVERT(VARCHAR(8), DeliveryDate, 112) AS DATETIME) AS MetricDate,
              ValueStream AS ValueStream,
              SUM(CASE WHEN OnTime = 1 THEN 1 ELSE 0 END) AS OtifOnTimeCount,
              COUNT(*) AS OtifTotalCount
            FROM log.OtifSnapshot
            GROUP BY CONVERT(VARCHAR(8), DeliveryDate, 112), ValueStream
            """, cancellationToken: ct));

        foreach (var row in rows)
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                IF EXISTS (SELECT 1 FROM log.DailyPerformance WHERE MetricDate = @MetricDate AND ValueStream = @ValueStream)
                  UPDATE log.DailyPerformance
                  SET OtifOnTimeCount = @OtifOnTimeCount, OtifTotalCount = @OtifTotalCount
                  WHERE MetricDate = @MetricDate AND ValueStream = @ValueStream
                ELSE
                  INSERT INTO log.DailyPerformance (MetricDate, ValueStream, OtifOnTimeCount, OtifTotalCount)
                  VALUES (@MetricDate, @ValueStream, @OtifOnTimeCount, @OtifTotalCount)
                """, row, cancellationToken: ct));
        }
    }

    /// <summary>Stock/Picked: point-in-time only — writes today's row on each refresh.</summary>
    internal static async Task UpsertTodayStockAndPickedAsync(IDbConnection connection, IReadOnlyDictionary<string, (decimal StockValue, decimal PickedValue)> totalsByValueStream, CancellationToken ct)
    {
        var today = DateTime.UtcNow.Date;
        foreach (var (valueStream, totals) in totalsByValueStream)
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                IF EXISTS (SELECT 1 FROM log.DailyPerformance WHERE MetricDate = @today AND ValueStream = @valueStream)
                  UPDATE log.DailyPerformance SET StockValue = @stock, PickedValue = @picked
                  WHERE MetricDate = @today AND ValueStream = @valueStream
                ELSE
                  INSERT INTO log.DailyPerformance (MetricDate, ValueStream, StockValue, PickedValue)
                  VALUES (@today, @valueStream, @stock, @picked)
                """, new { today, valueStream, stock = totals.StockValue, picked = totals.PickedValue }, cancellationToken: ct));
        }
    }

    // ── Delivery -> order link cache (log.DeliveryOrderLink) ─────────────

    internal static async Task<IReadOnlyDictionary<string, (string OrderNumber, string OrderItem)>> GetCachedDeliveryOrderLinksAsync(IDbConnection connection, IReadOnlyList<string> deliveryNumbers, CancellationToken ct)
    {
        if (deliveryNumbers.Count == 0) return new Dictionary<string, (string, string)>();

        var rows = await connection.QueryAsync<(string DeliveryNumber, string DeliveryItem, string OrderNumber, string OrderItem)>(new CommandDefinition("""
            SELECT DeliveryNumber, DeliveryItem, OrderNumber, OrderItem
            FROM log.DeliveryOrderLink
            WHERE DeliveryNumber IN @deliveryNumbers
            """, new { deliveryNumbers }, cancellationToken: ct));

        return rows.ToDictionary(r => $"{r.DeliveryNumber}||{r.DeliveryItem}", r => (r.OrderNumber, r.OrderItem));
    }

    /// <summary>Insert-only, by (DeliveryNumber, DeliveryItem) — a re-run of the daily sync never creates duplicates or disturbs an already-resolved row. Defensively deduped by that same key first — VBFA can occasionally surface more than one predecessor row for the same delivery item within a single batch, which would otherwise blow up the INSERT with a PRIMARY KEY violation.</summary>
    internal static Task InsertDeliveryOrderLinksIfMissingAsync(IDbConnection connection, IReadOnlyList<DeliveryOrderLinkRow> rows, CancellationToken ct)
    {
        if (rows.Count == 0) return Task.CompletedTask;

        var seen = new HashSet<string>();
        var deduped = rows.Where(r => seen.Add($"{r.DeliveryNumber}||{r.DeliveryItem}")).ToList();

        IReadOnlyList<SnapshotTableWriter.Column<DeliveryOrderLinkRow>> keyColumns =
        [
            new("DeliveryNumber", r => r.DeliveryNumber, 10),
            new("DeliveryItem", r => r.DeliveryItem, 6),
        ];
        IReadOnlyList<SnapshotTableWriter.Column<DeliveryOrderLinkRow>> columns =
        [
            new("OrderNumber", r => r.OrderNumber, 10),
            new("OrderItem", r => r.OrderItem, 6),
        ];
        return SnapshotTableWriter.UpsertAsync(connection, "log.DeliveryOrderLink", keyColumns, columns, deduped, ct, insertOnly: true);
    }
}
