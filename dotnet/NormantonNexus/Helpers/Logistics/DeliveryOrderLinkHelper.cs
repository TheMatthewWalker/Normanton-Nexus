using System.Data;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Resolves an agreement row whose ReferenceDocument is actually a delivery
/// number back to the real sales order number/item, via SAP table VBFA —
/// Logistics Sub-phase 8b.6. Port of routes/performanceorderlink.js's
/// resolveDeliveryReferenceDocuments.
///
/// Z_STOCK_REQ_LIST's ReferenceDocument holds the sales order number while an
/// order is open, but flips to the delivery number the instant SAP creates a
/// delivery against it. Order Book notes/risk flags (log.OrderBookLineNotes,
/// keyed on OriginalDoc+Material) need to stay attached to the same line
/// whether SAP is currently calling it an order or a delivery — without this,
/// a genuinely at-risk line's flag silently stops matching the moment it's
/// picked, making the line look "fine" again.
///
/// Deliberately does NOT touch ReferenceDocument/Item themselves — those stay
/// exactly as SAP returned them (order while open, delivery once picked),
/// because StockAllocationHelper.StagingBin's PickedStockAllocated match
/// keys off the raw delivery number Z_STOCK_REQ_LIST returned. OriginalDoc/
/// OriginalDocItem are purely additive: pass-through default for every row,
/// VBFA-resolved for delivery-shaped ones. Must run AFTER
/// StockAllocationHelper.AllocateStock (same staging-bin reason) and BEFORE
/// PerformanceSnapshotHelper.ReplaceAgreementSnapshotAsync (so
/// OriginalDoc/OriginalDocItem are populated before the snapshot write).
/// </summary>
internal static class DeliveryOrderLinkHelper
{
    // Delivery numbers in this SAP system start '008'; order numbers don't, so this prefix
    // check is how a "delivery-shaped" ReferenceDocument is recognised.
    private const string DeliveryNumberPrefix = "008";

    private static bool IsDeliveryShaped(string? referenceDocument) =>
        referenceDocument is not null && referenceDocument.Trim().StartsWith(DeliveryNumberPrefix, StringComparison.Ordinal);

    internal static async Task ResolveDeliveryReferenceDocumentsAsync(IDbConnection connection, ISapServerClient sap, int userId, IReadOnlyList<SapAgreementRow> rows, CancellationToken ct)
    {
        // Pass-through default for every row — candidates below overwrite this with the
        // VBFA-resolved order number/item where one was found.
        foreach (var row in rows)
        {
            row.OriginalDoc = row.ReferenceDocument;
            row.OriginalDocItem = row.Item ?? "";
        }

        var candidates = rows.Where(r => IsDeliveryShaped(r.ReferenceDocument)).ToList();
        if (candidates.Count == 0) return;

        var deliveryNumbers = candidates.Select(r => r.ReferenceDocument.Trim()).Distinct().ToList();

        var cached = await PerformanceSnapshotHelper.GetCachedDeliveryOrderLinksAsync(connection, deliveryNumbers, ct);
        var linkMap = cached.ToDictionary(kv => kv.Key, kv => kv.Value);
        var cachedDeliveries = linkMap.Keys.Select(k => k.Split("||")[0]).ToHashSet();
        var uncached = deliveryNumbers.Where(d => !cachedDeliveries.Contains(d)).ToList();

        if (uncached.Count > 0)
        {
            // Modest concurrency, not a single unbounded fan-out — this can run for dozens of
            // newly-picked deliveries in one sync cycle and each is its own RFC round-trip.
            const int concurrency = 5;
            var newRows = new List<DeliveryOrderLinkRow>();

            for (var i = 0; i < uncached.Count; i += concurrency)
            {
                var batch = uncached.Skip(i).Take(concurrency).ToList();
                var results = await Task.WhenAll(batch.Select(async delivery =>
                {
                    try
                    {
                        var links = await sap.GetAsync<List<SapVbfaOrderLinkRow>>($"api/performance/vbfa-order-link/{Uri.EscapeDataString(delivery)}", userId, ct: ct) ?? [];
                        return (Delivery: delivery, Links: (IReadOnlyList<SapVbfaOrderLinkRow>)links, Failed: false);
                    }
                    catch (Exception)
                    {
                        // Best-effort: a VBFA lookup failure shouldn't block the sync — worst case
                        // a handful of freshly-picked lines keep the delivery number (and their
                        // notes/risk flags) until the next successful sync.
                        return (Delivery: delivery, Links: (IReadOnlyList<SapVbfaOrderLinkRow>)[], Failed: true);
                    }
                }));

                foreach (var result in results)
                {
                    if (result.Failed) continue;
                    foreach (var link in result.Links)
                        newRows.Add(new DeliveryOrderLinkRow(result.Delivery, link.DeliveryItem, link.OrderNumber, link.OrderItem));
                }
            }

            if (newRows.Count > 0)
            {
                await PerformanceSnapshotHelper.InsertDeliveryOrderLinksIfMissingAsync(connection, newRows, ct);
                foreach (var r in newRows) linkMap[$"{r.DeliveryNumber}||{r.DeliveryItem}"] = (r.OrderNumber, r.OrderItem);
            }
            // Note: a delivery with genuinely no VBFA 'J' link (e.g. manually created in SAP with
            // no source order) gets nothing added here, so it'll be retried as "uncached" on
            // every future sync — a known, minor inefficiency, not worth a negative-result cache
            // entry for what should be a rare case.
        }

        foreach (var row in candidates)
        {
            var delivery = row.ReferenceDocument.Trim();
            var item = (row.Item ?? "").Trim();

            if (linkMap.TryGetValue($"{delivery}||{item}", out var link))
            {
                row.OriginalDoc = link.OrderNumber;
                row.OriginalDocItem = link.OrderItem;
            }
            // else: no VBFA link found for this exact item — OriginalDoc/OriginalDocItem stay at
            // the pass-through default set above (the raw delivery number/item). Not logged —
            // routine/expected for any delivery SAP hasn't yet written a VBFA 'J' record for.
        }
    }
}
