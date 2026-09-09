using System.Text.RegularExpressions;
using NormantonNexus.Models.Dto;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// FIFO stock allocation — Logistics Sub-phase 8b.6. Port of
/// routes/performanceallocation.js. Splits each open agreement (requirement)
/// row's order quantity against two independent pools built from the same
/// stock pull: "available" dock stock (grouped by material + packaging
/// customer, oldest requirement served first) and "staged/picked" stock
/// (grouped by material + storage bin, keyed off the requirement's own
/// staging bin — see StagingBin). Mutates each agreement row's
/// DockStockAllocated/PickedStockAllocated in place, same as Node's own
/// mutate-in-place allocateStock.
/// </summary>
internal static partial class StockAllocationHelper
{
    [GeneratedRegex(@"^IB_(\w+?)_")]
    private static partial Regex PackagingCustomerPattern();

    internal static string? PackagingCustomer(string? packagingMaterial)
    {
        var match = PackagingCustomerPattern().Match(packagingMaterial ?? "");
        return match.Success ? match.Groups[1].Value : null;
    }

    internal static string StagingBin(string? referenceDocument) => (referenceDocument ?? "").PadLeft(10, '0');

    private static string DefaultStockKey(SapPerformanceStockRow s) => $"{s.Material}|{PackagingCustomer(s.PackagingMaterial)}";

    private static string DefaultAgreementKey(SapAgreementRow a) => $"{a.Material}|{a.Customer}";

    internal static IReadOnlyList<SapAgreementRow> AllocateStock(IReadOnlyList<SapAgreementRow> agreementRows, IReadOnlyList<SapPerformanceStockRow> stockRows)
    {
        var availablePool = new Dictionary<string, decimal>();
        foreach (var s in stockRows)
        {
            var key = DefaultStockKey(s);
            availablePool[key] = availablePool.GetValueOrDefault(key) + s.AvailableQty;
        }

        var stagedPool = new Dictionary<string, decimal>();
        foreach (var s in stockRows)
        {
            var key = $"{s.Material}|{s.StorageBin}";
            stagedPool[key] = stagedPool.GetValueOrDefault(key) + s.TotalQty;
        }

        var sorted = agreementRows.OrderBy(a => a.RequestDate).ToList();

        foreach (var row in sorted)
        {
            var key = DefaultAgreementKey(row);
            var remainingAvailable = Math.Max(availablePool.GetValueOrDefault(key), 0m);
            row.DockStockAllocated = Math.Min(row.OrderQty, remainingAvailable);
            availablePool[key] = remainingAvailable - row.DockStockAllocated;

            var stagedKey = $"{row.Material}|{StagingBin(row.ReferenceDocument)}";
            var remainingStaged = Math.Max(stagedPool.GetValueOrDefault(stagedKey), 0m);
            row.PickedStockAllocated = Math.Min(row.OrderQty, remainingStaged);
            stagedPool[stagedKey] = remainingStaged - row.PickedStockAllocated;
        }

        return sorted;
    }
}
