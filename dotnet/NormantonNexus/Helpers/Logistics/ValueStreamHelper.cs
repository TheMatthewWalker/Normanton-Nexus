using NormantonNexus.Models.Dto;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Profit centre -&gt; value stream mapping — Logistics Sub-phase 8b.6. Port of
/// routes/performancevaluestream.js. Single source of truth for ValueStream
/// assignment; every dataset (stock, agreements, invoicing, otif) carries a
/// profit centre on each record from the SAP download, and each record is
/// mapped independently — no cross-dataset material lookups. An unmapped
/// centre returns null, meaning "excluded from the snapshot" (see
/// PerformanceSyncHelper's replace calls, which filter these out the same
/// way replaceTable() does in Node).
/// </summary>
internal static class ValueStreamHelper
{
    private static readonly IReadOnlyDictionary<string, string> CentreToArea = new Dictionary<string, string>
    {
        ["2000"] = "PTFE", ["2001"] = "PTFE", ["2002"] = "PTFE", ["2003"] = "PTFE", ["2004"] = "PTFE",
        ["2005"] = "PTFE", ["2006"] = "PTFE", ["2007"] = "PTFE", ["2008"] = "PV", ["2009"] = "PTFE",
        ["2010"] = "PV", ["2011"] = "PV", ["2012"] = "PTFE", ["2013"] = "PV", ["2014"] = "PV",
        ["2015"] = "PV", ["2016"] = "PTFE", ["2017"] = "PV", ["2018"] = "PV", ["2019"] = "PV",
        ["2021"] = "PTFE", ["2022"] = "PTFE", ["2023"] = "PTFE", ["2024"] = "PV", ["2026"] = "PV",
        ["2028"] = "PV", ["9912"] = "PTFE",
    };

    /// <summary>SAP PRCTR arrives either bare ("2008") or zero-padded to 10 ("0000002008").</summary>
    internal static string? MapProfitCentreToValueStream(string? profitCentre)
    {
        if (string.IsNullOrEmpty(profitCentre)) return null;
        var centre = profitCentre.Trim().TrimStart('0');
        return centre.Length == 0 ? null : CentreToArea.GetValueOrDefault(centre);
    }

    internal static void EnrichWithValueStream(IEnumerable<SapPerformanceStockRow> rows)
    {
        foreach (var row in rows) row.ValueStream = MapProfitCentreToValueStream(row.ProfitCentre);
    }

    internal static void EnrichWithValueStream(IEnumerable<SapAgreementRow> rows)
    {
        foreach (var row in rows) row.ValueStream = MapProfitCentreToValueStream(row.ProfitCentre);
    }

    internal static void EnrichWithValueStream(IEnumerable<SapInvoiceRow> rows)
    {
        foreach (var row in rows) row.ValueStream = MapProfitCentreToValueStream(row.ProfitCentre);
    }

    internal static void EnrichWithValueStream(IEnumerable<SapOtifRow> rows)
    {
        foreach (var row in rows) row.ValueStream = MapProfitCentreToValueStream(row.ProfitCentre);
    }

    /// <summary>valueStream -&gt; (stockValue, pickedValue), from each allocated agreement row's implied unit price (LocalAmount / OrderQty). "UNKNOWN" buckets a row with no value-stream mapping — same as Node's own fallback key.</summary>
    internal static IReadOnlyDictionary<string, (decimal StockValue, decimal PickedValue)> ComputeTodayStockAndPickedTotals(IEnumerable<SapAgreementRow> allocatedAgreementRows)
    {
        var totals = new Dictionary<string, (decimal StockValue, decimal PickedValue)>();

        void Add(string valueStream, bool isStock, decimal amount)
        {
            if (amount == 0) return;
            var current = totals.GetValueOrDefault(valueStream, (0m, 0m));
            totals[valueStream] = isStock ? (current.Item1 + amount, current.Item2) : (current.Item1, current.Item2 + amount);
        }

        foreach (var row in allocatedAgreementRows)
        {
            var unitPrice = row.OrderQty != 0 ? row.LocalAmount / row.OrderQty : 0m;
            var valueStream = row.ValueStream ?? "UNKNOWN";
            Add(valueStream, isStock: true, row.DockStockAllocated * unitPrice);
            Add(valueStream, isStock: false, row.PickedStockAllocated * unitPrice);
        }

        return totals;
    }
}
