using System.Text.RegularExpressions;
using Dapper;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Warehouse;

/// <summary>
/// Hourly SAP sync — Phase 10 cross-cutting closeout (discovered missing
/// while wiring Quartz.NET jobs; Node runs this at xx:55 via server.js's
/// cron and also exposes it as a manual "/sap-sync" LOG_SUPER-gated button,
/// both calling the exact same function). Port of
/// routes/deliverymain.js's runSapSync in full: pulls SAP's open
/// picksheets, auto-creates any log.Destinations row SAP knows about that
/// this app doesn't yet (via a KNA1 lookup for whatever's missing), inserts
/// new log.DeliveryMain rows for genuinely new deliveries, and reconciles —
/// anything Nexus still thinks is open that this SAP pull did NOT return is
/// assumed to have been picked/shipped directly in SAP, bypassing the
/// pallet builder entirely, and is swept into Packaging Holding
/// (completionStatus = 1, pendingPackagingData = 1) until someone confirms
/// its packaging by hand.
///
/// Always calls SapServer with the shared service token (userId 0) —
/// matches Node's own sap.js makeSapToken() exactly, which is hardcoded to
/// `{ userId: 0 }` with no caller-supplied override, used identically by
/// both the manual button and the cron trigger.
/// </summary>
internal static class WarehouseSapSyncHelper
{
    /// <summary>Node's sap.js makeSapToken() hardcodes `{ userId: 0 }` with no caller-supplied override — used identically by both the manual "/sap-sync" button and the cron trigger, so both C# callers pass this same constant rather than each other's actual authenticated user (there being none for the cron case anyway).</summary>
    internal const int ServiceUserId = 0;

    private sealed record DestinationLookupRow(long DestinationId, string? DefaultDeliveryService, string? DestinationComment, string? DestinationCountry);

    internal static async Task<SapSyncResult> RunSapSyncAsync(INexusOperationsDb db, ISapServerClient sap, int userId, CancellationToken ct)
    {
        var deliveries = await sap.GetAsync<List<SapPicksheetRow>>("api/logistics/picksheets/open", userId, ct: ct) ?? [];

        using var connection = await db.CreateConnectionAsync(ct);

        // Load all destinations once to derive deliveryService and picksheetComment.
        var destRows = await connection.QueryAsync<DestinationLookupRow>(new CommandDefinition("""
            SELECT destinationID AS DestinationId, defaultDeliveryService AS DefaultDeliveryService,
                   destinationComment AS DestinationComment, destinationCountry AS DestinationCountry
            FROM log.Destinations
            """, cancellationToken: ct));
        var destMap = destRows.ToDictionary(d => d.DestinationId);

        // ── Auto-create Destinations rows for customers SAP knows but we don't ──
        var autoCreated = new List<SapSyncAutoCreatedRow>();
        string? kna1Error = null;
        var missingCustomerIds = deliveries
            .Select(d => ParseLeadingLong(d.CustomerNumber))
            .Where(id => id is not null && !destMap.ContainsKey(id.Value))
            .Select(id => id!.Value)
            .Distinct()
            .ToList();

        if (missingCustomerIds.Count > 0)
        {
            try
            {
                var customers = missingCustomerIds.Select(id => id.ToString()).ToList();
                var kna1Rows = await sap.PostAsync<List<Kna1Row>>("api/customs/kna1", new { customers }, userId, ct: ct) ?? [];

                foreach (var row in kna1Rows)
                {
                    var custId = ParseLeadingLong(row.CustomerCode);
                    if (custId is null || destMap.ContainsKey(custId.Value)) continue;

                    var name = NullIfBlank(row.Name) ?? $"Customer {custId}";
                    var street = NullIfBlank(row.Street);
                    var city = NullIfBlank(row.City);
                    var postCode = NullIfBlank(row.PostCode);
                    var country = NullIfBlank(row.DestinationCountry);
                    var zone = NullIfBlank(row.TransportZone);
                    var incoterms = NullIfBlank(row.Incoterms);

                    try
                    {
                        await connection.ExecuteAsync(new CommandDefinition("""
                            INSERT INTO log.Destinations
                                (destinationID, destinationName, destinationStreet, destinationCity,
                                 destinationPostCode, destinationCountry, defaultIncoterms,
                                 destinationComment, destinationZone, defaultDeliveryService, defaultForwarder)
                            SELECT @custId, @name, @street, @city, @postCode, @country, @incoterms, NULL, @zone, NULL, NULL
                            WHERE NOT EXISTS (SELECT 1 FROM log.Destinations WHERE destinationID = @custId)
                            """, new { custId = custId.Value, name, street, city, postCode, country, incoterms, zone }, cancellationToken: ct));

                        // Feed straight back into destMap so this sync run picks the delivery up
                        // immediately instead of needing a second sync.
                        destMap[custId.Value] = new DestinationLookupRow(custId.Value, null, null, country);
                        autoCreated.Add(new SapSyncAutoCreatedRow(custId.Value.ToString(), name,
                            NeedsReview: street is null || city is null || postCode is null || country is null));
                    }
                    catch (Exception ex)
                    {
                        // Leave it unset — falls through to `missing` below like before.
                        kna1Error ??= $"Insert failed for customer {custId}: {ex.Message}";
                    }
                }
            }
            catch (Exception ex)
            {
                // KNA1 lookup itself failed — every one of these customers just falls
                // through to `missing` in the loop below, same as pre-auto-create behavior.
                kna1Error = ex.Message;
            }
        }

        var errors = new List<SapSyncErrorRow>();
        var missing = new List<SapSyncMissingRow>();
        int inserted = 0, skipped = 0;

        foreach (var d in deliveries)
        {
            try
            {
                var deliveryId = ParseLeadingLong(d.DeliveryNumber);
                var customerId = ParseLeadingLong(d.CustomerNumber);
                var dispatchDate = ParseSapDate(d.DispatchDate);
                var incoterms = NullIfBlank(d.Incoterms);

                if (deliveryId is null || customerId is null || !destMap.TryGetValue(customerId.Value, out var dest))
                {
                    missing.Add(new SapSyncMissingRow(d.DeliveryNumber, d.CustomerNumber));
                    continue;
                }

                var deliveryService = (incoterms ?? "").Trim().ToUpperInvariant() == "EXW"
                    ? "Ex Works"
                    : !string.IsNullOrEmpty(dest.DefaultDeliveryService)
                        ? dest.DefaultDeliveryService
                        : (dest.DestinationCountry ?? "").Trim().ToUpperInvariant() == "UK" ? "Domestic" : "Groupage";
                var picksheetComment = dest.DestinationComment;

                var rowsAffected = await connection.ExecuteAsync(new CommandDefinition("""
                    INSERT INTO log.DeliveryMain
                        (deliveryID, customerID, dispatchDate, completionStatus, deliveryCancelled,
                         deliveryService, deliveryPriority, picksheetComment, incoterms)
                    SELECT @deliveryId, @customerId, @dispatchDate, 0, 0, @deliveryService, 0, @picksheetComment, @incoterms
                    WHERE NOT EXISTS (SELECT 1 FROM log.DeliveryMain WHERE deliveryID = @deliveryId)
                    """, new { deliveryId = deliveryId.Value, customerId = customerId.Value, dispatchDate, deliveryService, picksheetComment, incoterms }, cancellationToken: ct));

                if (rowsAffected > 0) inserted++; else skipped++;
            }
            catch (Exception ex)
            {
                errors.Add(new SapSyncErrorRow(d.DeliveryNumber, ex.Message));
            }
        }

        // ── Reconcile: pick up deliveries completed outside Nexus ──────────
        // Anything Nexus still thinks is open but that this SAP pull did NOT return is
        // assumed to have been picked/shipped directly in SAP — moved into Packaging
        // Holding until someone confirms its packaging via the normal pallet builder.
        // This trusts SAP's open-picksheets pull to be complete and accurate; a
        // transient SAP-side hiccup returning an incomplete list would incorrectly
        // sweep real open picksheets into holding — there's no independent signal
        // available here to tell the two cases apart (matches Node's own behavior).
        var sapOpenDeliveryIds = deliveries.Select(d => ParseLeadingLong(d.DeliveryNumber)).Where(id => id is not null).Select(id => id!.Value).ToHashSet();
        var openInNexus = await connection.QueryAsync<long>(new CommandDefinition(
            "SELECT deliveryID FROM log.DeliveryMain WHERE completionStatus = 0 AND ISNULL(deliveryCancelled, 0) = 0", cancellationToken: ct));

        var movedToHolding = new List<long>();
        foreach (var id in openInNexus)
        {
            if (sapOpenDeliveryIds.Contains(id)) continue;
            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE log.DeliveryMain SET completionStatus = 1, pendingPackagingData = 1, movedToHoldingAtUtc = GETUTCDATE()
                WHERE deliveryID = @id
                """, new { id }, cancellationToken: ct));
            movedToHolding.Add(id);
        }

        return new SapSyncResult(deliveries.Count, inserted, skipped, errors, missing, autoCreated, kna1Error, movedToHolding);
    }

    /// <summary>Mirrors JS's `parseInt(str, 10)` leniency (leading digits only, tolerant of trailing garbage) rather than requiring the whole string to be numeric — SAP's delivery/customer number fields are otherwise plain digit strings, but this matches Node's own parsing exactly rather than assuming.</summary>
    internal static long? ParseLeadingLong(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        var match = Regex.Match(s.Trim(), @"^[-+]?\d+");
        return match.Success && long.TryParse(match.Value, out var v) ? v : null;
    }

    /// <summary>SAP date as DD.MM.YYYY (the calling session's display format) — or null.</summary>
    internal static DateTime? ParseSapDate(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        var parts = s.Split('.');
        if (parts.Length != 3) return null;
        if (!int.TryParse(parts[0], out var day) || !int.TryParse(parts[1], out var month) || !int.TryParse(parts[2], out var year)) return null;
        try { return new DateTime(year, month, day); }
        catch (ArgumentOutOfRangeException) { return null; }
    }

    internal static string? NullIfBlank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}
