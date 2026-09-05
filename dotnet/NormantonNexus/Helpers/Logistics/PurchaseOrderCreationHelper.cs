using System.Data;
using Dapper;
using Microsoft.Extensions.Options;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Raises a real purchase order in SAP (BAPI_PO_CREATE1 via SapServer's
/// elevated /api/purchasing/create-po-elevated) for one or more Accepted,
/// not-yet-ordered tracked orders — Logistics Sub-phase 8b.7, the single
/// highest-scrutiny route in this sub-phase (per-user elevated SAP session
/// + an auto-generated, sendable legal document). Port of
/// routes/performance.js's POST /order-suggestions/create-po and its
/// regenerate-pdf sibling.
///
/// One PO per vendor, per the user: every suggestionId in the request must
/// belong to the same VendorId, matching how Build Order already groups
/// several materials from one vendor into one order. Runs under the
/// calling user's own SAP credentials (My Account -&gt; SAP Credentials,
/// decrypted just-in-time via ISapCredentialCipher), not the shared service
/// account — see SapServer's PurchasingController.CreatePurchaseOrderElevated
/// for why the shared account can't create POs at all. Same authorization
/// pattern as Sub-phase 8a.5b's ShipmentCostSapPostingHelper.PostMigoAsync.
/// </summary>
internal static class PurchaseOrderCreationHelper
{
    private sealed record SapCredentialsRow(string? SapUsername, string? SapPasswordEncrypted);

    private static async Task<(string Username, string Password)?> GetDecryptedSapCredentialsAsync(INexusDb nexusDb, ISapCredentialCipher cipher, int userId, CancellationToken ct)
    {
        using var connection = await nexusDb.CreateConnectionAsync(ct);
        var row = await connection.QuerySingleOrDefaultAsync<SapCredentialsRow>(new CommandDefinition(
            "SELECT SapUsername, SapPasswordEncrypted FROM dbo.PortalUsers WHERE UserID = @userId", new { userId }, cancellationToken: ct));

        if (string.IsNullOrEmpty(row?.SapUsername) || string.IsNullOrEmpty(row.SapPasswordEncrypted)) return null;
        return (row.SapUsername, cipher.Decrypt(row.SapPasswordEncrypted));
    }

    /// <summary>Best-effort read of a just-created (or existing) PO's real SAP price per item, via SapServer's GET /api/purchasing/{poNumber}/price. Swallows any failure and returns an empty map rather than letting a lookup problem block PDF generation — the PDF already falls back to "Per SAP condition" when a line has no price, the same behaviour as if this call was never made at all.</summary>
    private static async Task<IReadOnlyDictionary<string, decimal>> QueryPoPricesFromSapAsync(ISapServerClient sap, string poNumber, int userId, CancellationToken ct)
    {
        try
        {
            return await sap.GetAsync<Dictionary<string, decimal>>($"api/purchasing/{Uri.EscapeDataString(poNumber)}/price", userId, ct: ct) ?? new Dictionary<string, decimal>();
        }
        catch (Exception)
        {
            return new Dictionary<string, decimal>();
        }
    }

    /// <summary>Looks up the acting user's own display name (First+Last, falling back to Username) for the PO PDF's sign-off block. Best-effort: a lookup failure must not block PDF generation, so this returns null (the PDF already renders a blank signature line when unset) rather than throwing.</summary>
    private static async Task<string?> GetUserDisplayNameAsync(INexusDb nexusDb, int userId, CancellationToken ct)
    {
        try
        {
            using var connection = await nexusDb.CreateConnectionAsync(ct);
            return await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition("""
                SELECT COALESCE(NULLIF(RTRIM(ISNULL(FirstName,'')+' '+ISNULL(LastName,'')), ''), Username) AS DisplayName
                FROM dbo.PortalUsers WHERE UserID = @userId
                """, new { userId }, cancellationToken: ct));
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// Shared shape-builder for both create-po (right after SAP hands back a new PO number) and
    /// regenerate-pdf (rebuilding the document later for an already-created PO) — same
    /// quantity/unit conversion, EXW-aware delivery date, and price fallback chain (manual
    /// override -&gt; SAP-queried price -&gt; null/"Per SAP condition") either way, so the PDF a buyer
    /// downloads later never drifts from the one generated at creation time for the same PO.
    /// pricesByPoItem is keyed by a bare integer string ("10", not "00010") — see SapServer's
    /// PurchasingHelper.ParsePoPrices' own comment: POCOND's real ITM_NUMBER field is 6 digits
    /// ("000010"), not the 5-digit x10 numbering used here, so both sides normalise to a plain
    /// integer rather than relying on either one's padding width matching the other.
    /// </summary>
    internal static IReadOnlyList<PoPdfItem> BuildPoPdfItems(
        IReadOnlyList<OrderSuggestionTrackedRow> rows,
        IReadOnlyDictionary<long, decimal>? overridesById = null,
        IReadOnlyDictionary<string, decimal>? pricesByPoItem = null)
    {
        overridesById ??= new Dictionary<long, decimal>();
        pricesByPoItem ??= new Dictionary<string, decimal>();

        return rows.Select((r, i) =>
        {
            var poItemNumber = string.IsNullOrEmpty(r.PoItemNumber) ? ((i + 1) * 10).ToString("D5") : r.PoItemNumber;
            var baseUnit = r.Uom ?? "KG";
            var orderUnit = r.OrderMoqUom ?? baseUnit;
            var isExw = string.Equals(r.Incoterms, "EXW", StringComparison.OrdinalIgnoreCase);

            var netPrice = overridesById.TryGetValue(r.SuggestionId, out var overridePrice)
                ? overridePrice
                : (pricesByPoItem.TryGetValue(int.Parse(poItemNumber).ToString(), out var sapPrice) ? sapPrice : (decimal?)null);

            // EXW: goods are collected from the vendor's own site, not delivered to Kongsberg —
            // the meaningful date is when they're ready for collection, not a delivery date.
            var deliveryDate = isExw ? (r.ReadyToCollectDate ?? r.DeliveryDate) : r.DeliveryDate;

            return new PoPdfItem(poItemNumber, r.Material, r.MaterialText, UnitConversionHelper.ConvertQty(r.OrderQty, baseUnit, orderUnit), orderUnit, deliveryDate, isExw, netPrice);
        }).ToList();
    }

    /// <summary>
    /// Fresh, authoritative validation before any SAP call — a row's status/PO could have changed
    /// since the page was last loaded, so every selected line is re-fetched from the DB rather
    /// than trusted from whatever the client had on screen.
    /// </summary>
    internal static async Task<CreatePoResult> CreatePoAsync(
        INexusOperationsDb db, INexusDb nexusDb, ISapServerClient sap, ISapCredentialCipher credentialCipher, IOptions<LogisticsOptions> logisticsOptions,
        CreatePoRequest body, int callerUserId, CancellationToken ct)
    {
        if (body.SuggestionIds is not { Count: > 0 }) throw new NexusValidationException("suggestionIds must be a non-empty array.");

        var creds = await GetDecryptedSapCredentialsAsync(nexusDb, credentialCipher, callerUserId, ct);
        if (creds is null)
            throw new NexusValidationException("You need to save your SAP username and password in My Account before creating a PO in SAP.");

        var idSet = body.SuggestionIds.ToHashSet();
        var allTracked = await PurchaseOrderSuggestionHelper.ListTrackedAsync(db, ct);
        var rows = allTracked.Where(r => idSet.Contains(r.SuggestionId)).ToList();

        if (rows.Count != body.SuggestionIds.Count)
            throw new NexusNotFoundException("One or more selected orders could not be found.");

        var alreadyOrdered = rows.Where(r => !string.IsNullOrEmpty(r.PoNumber) || r.Status != "Accepted").ToList();
        if (alreadyOrdered.Count > 0)
            throw new NexusValidationException($"{alreadyOrdered.Count} of the selected line(s) already have a PO number or aren't in Accepted status — refresh and try again.");

        var vendorIds = rows.Select(r => r.VendorId).ToHashSet();
        if (vendorIds.Count > 1)
            throw new NexusValidationException("All selected lines must be from the same vendor — one purchase order per vendor.");

        if (string.IsNullOrEmpty(rows[0].SapVendorNumber))
            throw new NexusValidationException($"{rows[0].VendorName} has no SAP Vendor Number set — add one on the Vendor Master Data page before creating a PO in SAP.");

        var currency = body.Currency ?? rows[0].Currency;
        if (string.IsNullOrEmpty(currency))
            throw new NexusValidationException($"{rows[0].VendorName} has no currency set — add one on the Vendor Master Data page, or supply one when creating the PO.");

        var overridesById = (body.PriceOverrides ?? []).Where(o => o.NetPrice is not null).ToDictionary(o => o.SuggestionId, o => o.NetPrice!.Value);

        // OrderQty is always in the material's SAP base unit internally — a vendor that requires
        // orders placed in a different unit (log.Vendor.OrderMoqUom) needs that conversion
        // applied right here, at the boundary to the real SAP PO, so BAPI_PO_CREATE1's
        // PO_UNIT/QUANTITY (and the resulting real PO in SAP) match what the vendor requires.
        var today = DateTime.UtcNow.ToString("yyyy-MM-dd");
        var items = rows.Select(r =>
        {
            var baseUnit = r.Uom ?? "KG";
            var orderUnit = r.OrderMoqUom ?? baseUnit;
            return new SapPoCreateElevatedItem(
                Material: r.Material,
                ShortText: (r.MaterialText ?? r.Material ?? "")[..Math.Min(40, (r.MaterialText ?? r.Material ?? "").Length)],
                Quantity: UnitConversionHelper.ConvertQty(r.OrderQty, baseUnit, orderUnit),
                Unit: orderUnit,
                NetPrice: overridesById.TryGetValue(r.SuggestionId, out var overridePrice) ? overridePrice : null,
                DeliveryDate: (r.DeliveryDate ?? DateTime.UtcNow).ToString("yyyy-MM-dd"));
        }).ToList();

        var sapResponse = await sap.PostAsync<SapPoCreateElevatedResponse>(
            "api/purchasing/create-po-elevated",
            new SapPoCreateElevatedRequest(creds.Value.Username, creds.Value.Password, rows[0].SapVendorNumber!, currency, body.DocDate?.ToString("yyyy-MM-dd") ?? today, items),
            callerUserId, longRunning: true, ct: ct)
            ?? throw new NexusBadGatewayException("SapServer returned an empty response.");

        if (!sapResponse.Success || string.IsNullOrEmpty(sapResponse.PurchaseOrder))
            throw new NexusValidationException("SAP did not return a purchase order number.");

        var poNumber = sapResponse.PurchaseOrder;

        // poItemNumber is computed here from each row's index in `rows` — the SAME array `items`
        // was mapped from above, in the SAME order — because SapServer's BuildPoCreateRequest
        // assigns POITEM numbers purely by array position (standard SAP x10 numbering) and
        // BAPI_PO_CREATE1's response only hands back the overall PO number, not per-item numbers.
        for (var i = 0; i < rows.Count; i++)
        {
            var r = rows[i];
            var poItemNumber = ((i + 1) * 10).ToString("D5");
            await PurchaseOrderSuggestionHelper.UpdateStatusAsync(db, r.SuggestionId,
                new UpdateOrderSuggestionStatusRequest("Ordered", poNumber, poItemNumber, r.Notes, r.SupplierReference, null, null, null), ct);
        }

        // Auto-generate and file a sendable PO PDF — the PO already exists for real in SAP at
        // this point, so a PDF/filesystem failure here must not make the request look like it
        // failed — it's surfaced in the response as PoPdfError instead.
        var poPdfSaved = false;
        string? poPdfError = null;
        try
        {
            var rowsWithPoItem = rows.Select((r, i) => r with { PoItemNumber = ((i + 1) * 10).ToString("D5") }).ToList();
            var pricesTask = QueryPoPricesFromSapAsync(sap, poNumber, callerUserId, ct);
            var purchaserNameTask = GetUserDisplayNameAsync(nexusDb, callerUserId, ct);
            await Task.WhenAll(pricesTask, purchaserNameTask);

            var pdfItems = BuildPoPdfItems(rowsWithPoItem, overridesById, await pricesTask);
            var pdfBytes = PurchaseOrderPdfHelper.BuildPoPdf(new PoPdfData(
                poNumber, body.DocDate ?? DateTime.UtcNow, rows[0].VendorName, rows[0].SapVendorNumber, currency, rows[0].Incoterms, await purchaserNameTask, pdfItems));

            await InboundShipmentHelper.SavePoPdfAsync(rows[0].VendorName, poNumber, pdfBytes, logisticsOptions.Value, ct);
            poPdfSaved = true;
        }
        catch (Exception ex)
        {
            poPdfError = ex.Message;
        }

        return new CreatePoResult(poNumber, rows.Select(r => r.SuggestionId).ToList(), sapResponse.Messages, poPdfSaved, poPdfError);
    }

    /// <summary>
    /// Rebuilds and re-saves a PO PDF for an order line that already has a real SAP PO on file
    /// (Tracked Orders' "Recreate PO PDF") — for a document that was lost, needs resending, or was
    /// generated before a later fix. Does NOT touch SAP's PO at all beyond the best-effort price
    /// re-query — the PO itself already exists; this only re-renders the document, overwriting
    /// whatever's currently saved. Re-queries SAP for the current price the same way create-po
    /// does, so a reprint always reflects the price SAP has on file NOW, not whatever a manual
    /// override said when the PO was first raised (overrides aren't persisted anywhere to still
    /// apply here).
    /// </summary>
    internal static async Task<RegeneratePoPdfResult> RegeneratePdfAsync(
        INexusOperationsDb db, INexusDb nexusDb, ISapServerClient sap, IOptions<LogisticsOptions> logisticsOptions,
        RegeneratePoPdfRequest body, int callerUserId, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(body.PoNumber)) throw new NexusValidationException("poNumber is required.");

        var rows = await PurchaseOrderSuggestionHelper.ListByPoNumberAsync(db, body.PoNumber, ct);
        if (rows.Count == 0) throw new NexusNotFoundException($"No order lines found for PO {body.PoNumber}.");

        var pricesTask = QueryPoPricesFromSapAsync(sap, body.PoNumber, callerUserId, ct);
        var purchaserNameTask = GetUserDisplayNameAsync(nexusDb, callerUserId, ct);
        await Task.WhenAll(pricesTask, purchaserNameTask);

        var pdfItems = BuildPoPdfItems(rows, pricesByPoItem: await pricesTask);
        var pdfBytes = PurchaseOrderPdfHelper.BuildPoPdf(new PoPdfData(
            body.PoNumber, rows[0].OrderDate, rows[0].VendorName, rows[0].SapVendorNumber, rows[0].Currency, rows[0].Incoterms, await purchaserNameTask, pdfItems));

        await InboundShipmentHelper.SavePoPdfAsync(rows[0].VendorName, body.PoNumber, pdfBytes, logisticsOptions.Value, ct);

        return new RegeneratePoPdfResult(body.PoNumber, true);
    }
}
