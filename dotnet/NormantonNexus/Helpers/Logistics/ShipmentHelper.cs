using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Shipping (outbound) lifecycle core — Logistics Sub-phase 8a.1. Port of
/// the CRUD/lifecycle slice of routes/shipmentmain.js: queues, mark
/// collected/delivered/booked/unbooked, cancel, create (from deliveries or
/// manual), delivery add/remove, status/forwarder corrections, search, and
/// events. Deliberately excludes: manual cargo lines + document-folder
/// management (8a.2), PDF generation (8a.3), the hand-rolled SMTP
/// collection email (8a.4), and ClearPort customs + SAP cost posting
/// (8a.5) — see dotnet/CLAUDE.md's Phase 8 section for the full breakdown.
///
/// All against the NexusOperations database (log.ShipmentMain/
/// ShipmentEvents/ShipmentLink/DeliveryMain/DeliveryLink/PalletMain/
/// Destinations/Email/Forwarders) except DataChangeLog attribution
/// (Nexus database, via IDataChangeLogService).
/// </summary>
internal static class ShipmentHelper
{
    // ── Queues ────────────────────────────────────────────────────────

    /// <summary>Mirrors Node's buildShipmentQueueFilter/applySiteMatch exactly — the "origin"/"destination" site match compares the shipment's own originID/originName (or destinationID/destinationName) against this app's configured site identity, since a shipment could in principle be sourced from/destined to a site other than this one.</summary>
    internal static async Task<IReadOnlyList<ShipmentRow>> GetQueueAsync(INexusOperationsDb db, IOptions<LogisticsOptions> options, string mode, CancellationToken ct)
    {
        var settings = options.Value;
        using var connection = await db.CreateConnectionAsync(ct);

        var (whereClause, parameters) = BuildQueueFilter(mode, settings);

        var rows = await connection.QueryAsync<ShipmentRow>(new CommandDefinition($"""
            SELECT DISTINCT
                sm.shipmentID AS ShipmentId, sm.originID AS OriginId, sm.originName AS OriginName, sm.originStreet AS OriginStreet, sm.originCity AS OriginCity, sm.originPostCode AS OriginPostCode, sm.originCountry AS OriginCountry,
                sm.destinationID AS DestinationId, sm.destinationName AS DestinationName, sm.destinationStreet AS DestinationStreet, sm.destinationCity AS DestinationCity, sm.destinationPostCode AS DestinationPostCode, sm.destinationCountry AS DestinationCountry,
                sm.netWeight AS NetWeight, sm.grossWeight AS GrossWeight, sm.palletCount AS PalletCount, sm.shipmentVolume AS ShipmentVolume,
                sm.plannedCollection AS PlannedCollection, sm.actualCollection AS ActualCollection,
                CAST(ISNULL(sm.collectionStatus, 0) AS bit) AS CollectionStatus,
                sm.forwarderID AS ForwarderId, sm.trackingNumber AS TrackingNumber, sm.incoTerms AS IncoTerms,
                sm.customsRequired AS CustomsRequired, sm.customsComplete AS CustomsComplete, sm.shipmentCancelled AS ShipmentCancelled,
                sm.PlannedDelivery AS PlannedDelivery, sm.ActualDelivery AS ActualDelivery,
                CAST(ISNULL(sm.deliveryStatus, 0) AS bit) AS DeliveryStatus,
                sm.bookingStatus AS BookingStatus, sm.customsID AS CustomsId, sm.IsManual AS IsManual,
                fa.forwarderName AS ForwarderName, fa.forwarderMode AS ForwarderMode,
                CASE WHEN ISNULL(sm.plannedDelivery, '1900-01-01') > '1900-01-01' THEN sm.plannedDelivery ELSE sm.plannedCollection END AS PlannedMovement
            FROM log.ShipmentMain sm
            OUTER APPLY (
                SELECT TOP 1 f.forwarderName, f.forwarderMode FROM log.Forwarders f WHERE f.forwarderID = sm.forwarderID
            ) fa
            WHERE {whereClause}
            ORDER BY
                CASE WHEN ISNULL(sm.plannedDelivery, '1900-01-01') > '1900-01-01' THEN sm.plannedDelivery ELSE sm.plannedCollection END ASC,
                sm.shipmentID ASC
            """, parameters, cancellationToken: ct));
        return rows.AsList();
    }

    private static (string WhereClause, object Parameters) BuildQueueFilter(string mode, LogisticsOptions settings) => mode switch
    {
        "awaiting-collection" => (
            "ISNULL(sm.shipmentCancelled, 0) = 0 AND ISNULL(sm.bookingStatus, 0) = 1 AND ISNULL(sm.collectionStatus, 0) = 0 AND ((@originSiteId IS NOT NULL AND sm.originID = @originSiteId) OR (sm.originName = @originSiteName))",
            new { originSiteId = settings.OriginId, originSiteName = settings.OriginName }),
        "inbound" => (
            "ISNULL(sm.shipmentCancelled, 0) = 0 AND ISNULL(sm.collectionStatus, 0) = 1 AND ISNULL(sm.deliveryStatus, 0) = 0 AND ((@destinationSiteId IS NOT NULL AND sm.destinationID = @destinationSiteId) OR (sm.destinationName = @destinationSiteName))",
            new { destinationSiteId = settings.OriginId, destinationSiteName = settings.OriginName }),
        "in-transit" => (
            "ISNULL(sm.shipmentCancelled, 0) = 0 AND ISNULL(sm.collectionStatus, 0) = 1 AND ISNULL(sm.deliveryStatus, 0) = 0 AND ((@transitOriginSiteId IS NOT NULL AND sm.originID = @transitOriginSiteId) OR (sm.originName = @transitOriginSiteName))",
            new { transitOriginSiteId = settings.OriginId, transitOriginSiteName = settings.OriginName }),
        "awaiting-booking" => ("ISNULL(sm.shipmentCancelled, 0) = 0 AND ISNULL(sm.bookingStatus, 0) = 0", new { }),
        "customs-docs" => ("ISNULL(sm.shipmentCancelled, 0) = 0 AND ISNULL(sm.customsRequired, 0) = 1 AND ISNULL(sm.customsComplete, 0) = 0", new { }),
        _ => throw new NexusValidationException("Invalid shipment queue mode."),
    };

    // ── Collected / delivered ────────────────────────────────────────

    internal static async Task<BulkActionOutcome> MarkCollectedBulkAsync(INexusOperationsDb db, List<long> shipmentIds, string? description, string? actor, CancellationToken ct)
    {
        if (shipmentIds.Count == 0) throw new NexusValidationException("No shipments selected.");

        using var connection = await db.CreateConnectionAsync(ct);
        var completed = new List<long>();
        var failed = new List<BulkActionFailure>();

        foreach (var shipmentId in shipmentIds.Distinct())
        {
            try
            {
                var affected = await connection.ExecuteAsync(new CommandDefinition("""
                    UPDATE log.ShipmentMain SET collectionStatus = 1, actualCollection = GETDATE()
                    WHERE shipmentID = @shipmentId AND ISNULL(shipmentCancelled, 0) = 0 AND ISNULL(collectionStatus, 0) = 0
                    """, new { shipmentId }, cancellationToken: ct));
                if (affected == 0) throw new InvalidOperationException("Already collected or not found.");

                var eventDesc = string.Join(" | ", new[] { description, $"confirmed by {actor ?? "unknown"}" }.Where(s => !string.IsNullOrEmpty(s)));
                await WriteShipmentEventAsync(connection, shipmentId, "COLLECTED", eventDesc, ct);
                completed.Add(shipmentId);
            }
            catch (Exception ex)
            {
                failed.Add(new BulkActionFailure(shipmentId, ex.Message));
            }
        }

        return new BulkActionOutcome(completed, failed);
    }

    internal static async Task MarkCollectedAsync(INexusOperationsDb db, long shipmentId, string? actor, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var affected = await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.ShipmentMain SET collectionStatus = 1, actualCollection = GETDATE()
            WHERE shipmentID = @shipmentId AND ISNULL(shipmentCancelled, 0) = 0 AND ISNULL(collectionStatus, 0) = 0
            """, new { shipmentId }, cancellationToken: ct));

        if (affected == 0)
            throw new NexusConflictException("Shipment could not be marked as collected.");

        await WriteShipmentEventAsync(connection, shipmentId, "COLLECTED", $"Shipment marked as collected by {actor ?? "unknown"}", ct);
    }

    internal static async Task MarkDeliveredAsync(INexusOperationsDb db, long shipmentId, DateTime? actualDelivery, string? actor, CancellationToken ct)
    {
        var when = actualDelivery ?? DateTime.Now;
        using var connection = await db.CreateConnectionAsync(ct);
        var affected = await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.ShipmentMain SET deliveryStatus = 1, actualDelivery = COALESCE(@when, GETDATE())
            WHERE shipmentID = @shipmentId AND ISNULL(shipmentCancelled, 0) = 0 AND ISNULL(collectionStatus, 0) = 1 AND ISNULL(deliveryStatus, 0) = 0
            """, new { shipmentId, when }, cancellationToken: ct));

        if (affected == 0)
            throw new NexusConflictException("Shipment could not be marked as delivered.");

        await WriteShipmentEventAsync(connection, shipmentId, "DELIVERED", $"Delivered on {when:dd/MM/yyyy} - confirmed by {actor ?? "unknown"}", ct);
    }

    internal static async Task<BulkActionOutcome> MarkDeliveredBulkAsync(INexusOperationsDb db, List<long> shipmentIds, DateTime? actualDelivery, string? actor, CancellationToken ct)
    {
        if (shipmentIds.Count == 0) throw new NexusValidationException("No shipments selected.");
        var when = actualDelivery ?? DateTime.Now;

        using var connection = await db.CreateConnectionAsync(ct);
        var completed = new List<long>();
        var failed = new List<BulkActionFailure>();

        foreach (var shipmentId in shipmentIds.Distinct())
        {
            try
            {
                var affected = await connection.ExecuteAsync(new CommandDefinition("""
                    UPDATE log.ShipmentMain SET deliveryStatus = 1, actualDelivery = COALESCE(@when, GETDATE())
                    WHERE shipmentID = @shipmentId AND ISNULL(shipmentCancelled, 0) = 0 AND ISNULL(collectionStatus, 0) = 1 AND ISNULL(deliveryStatus, 0) = 0
                    """, new { shipmentId, when }, cancellationToken: ct));
                if (affected == 0) throw new InvalidOperationException("Already delivered, not yet collected, or cancelled.");

                await WriteShipmentEventAsync(connection, shipmentId, "DELIVERED", $"Delivered on {when:dd/MM/yyyy} - confirmed by {actor ?? "unknown"} (bulk)", ct);
                completed.Add(shipmentId);
            }
            catch (Exception ex)
            {
                failed.Add(new BulkActionFailure(shipmentId, ex.Message));
            }
        }

        return new BulkActionOutcome(completed, failed);
    }

    // ── Booking / unbooking ──────────────────────────────────────────

    internal static async Task<MarkBookedResult> MarkBookedAsync(INexusOperationsDb db, MarkBookedRequest body, CancellationToken ct)
    {
        var shipmentUpdates = body.Shipments ?? [];
        var shipmentIds = shipmentUpdates.Count > 0 ? shipmentUpdates.Select(s => s.ShipmentId).ToList() : (body.ShipmentIds ?? []).Distinct().ToList();
        if (shipmentIds.Count == 0)
            throw new NexusValidationException("Select at least one shipment before confirming booking.");

        using var connection = await db.CreateConnectionAsync(ct);
        using var transaction = connection.BeginTransaction();
        int updated;
        try
        {
            if (shipmentUpdates.Count > 0)
            {
                updated = 0;
                foreach (var item in shipmentUpdates)
                {
                    var affected = await connection.ExecuteAsync(new CommandDefinition("""
                        UPDATE log.ShipmentMain SET
                            bookingStatus = 1,
                            trackingNumber = COALESCE(NULLIF(@trackingNumber, ''), trackingNumber),
                            plannedCollection = COALESCE(@plannedCollection, plannedCollection),
                            plannedDelivery = COALESCE(@plannedDelivery, plannedDelivery),
                            forwarderID = COALESCE(@forwarderId, forwarderID)
                        WHERE shipmentID = @shipmentId AND ISNULL(shipmentCancelled, 0) = 0 AND ISNULL(bookingStatus, 0) = 0
                        """, new { shipmentId = item.ShipmentId, trackingNumber = item.TrackingNumber ?? "", item.PlannedCollection, item.PlannedDelivery, forwarderId = item.ForwarderId }, transaction, cancellationToken: ct));
                    updated += affected;
                }
            }
            else
            {
                updated = await connection.ExecuteAsync(new CommandDefinition("""
                    UPDATE log.ShipmentMain SET bookingStatus = 1
                    WHERE shipmentID IN @shipmentIds AND ISNULL(shipmentCancelled, 0) = 0 AND ISNULL(bookingStatus, 0) = 0
                    """, new { shipmentIds }, transaction, cancellationToken: ct));
            }

            transaction.Commit();
        }
        catch
        {
            transaction.Rollback();
            throw;
        }

        // Insert ShipmentCost rows for each booked shipment that has a cost —
        // outside the transaction above, matching Node's own structure
        // (pool2, a fresh connection, after tx.commit()) and its own
        // per-item try/catch-and-swallow (a failed cost-row insert must
        // never undo the booking that already committed).
        foreach (var item in shipmentUpdates)
        {
            if (item.SkipCost) continue;

            var modeOfTransport = await LogisticsReferenceHelper.LookupModeOfTransportAsync(db, item.ForwarderMode, ct);

            if (item.ExpectedCost is not null)
            {
                try
                {
                    await InsertShipmentCostAsync(db, item.ShipmentId, "1", item.ElementCode, item.CostCenter, item.ExpectedCost.Value, modeOfTransport, ct);
                }
                catch { /* best-effort, matching Node's swallowed try/catch */ }
            }

            if (item.CustomsCost is not null)
            {
                try
                {
                    // Customs cost (costType 2) — KN only, £50 DDP / £0 DAP; costElement 603120 is fixed, matching Node's own hardcoded GL code.
                    await InsertShipmentCostAsync(db, item.ShipmentId, "2", "603120", item.CostCenter, item.CustomsCost.Value, modeOfTransport, ct);
                }
                catch { /* best-effort */ }
            }
        }

        return new MarkBookedResult(updated);
    }

    private static async Task InsertShipmentCostAsync(INexusOperationsDb db, long shipmentId, string costType, string? costElement, string? costCenter, decimal expectedCost, string? modeOfTransport, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO log.ShipmentCost (shipmentID, costType, costElement, costCenter, expectedCost, actualCost, migoStatus, modeOfTransport)
            VALUES (@shipmentId, @costType, @costElement, @costCenter, @expectedCost, 0, 0, @modeOfTransport)
            """, new { shipmentId, costType, costElement, costCenter, expectedCost, modeOfTransport }, cancellationToken: ct));
    }

    /// <summary>Reverses a booking so it goes back into Awaiting Booking. Also deletes any not-yet-MIGO'd cost rows for the shipment — re-booking would otherwise insert a second freight-cost row on top of one never cleared, duplicating it in the expected-costs table. migoStatus=1 rows (already processed in SAP) are left alone.</summary>
    internal static async Task<BulkActionOutcome> UnbookAsync(INexusOperationsDb db, List<long> shipmentIds, string? actor, CancellationToken ct)
    {
        if (shipmentIds.Count == 0) throw new NexusValidationException("No shipments selected.");

        using var connection = await db.CreateConnectionAsync(ct);
        var completed = new List<long>();
        var failed = new List<BulkActionFailure>();

        foreach (var shipmentId in shipmentIds.Distinct())
        {
            using var transaction = connection.BeginTransaction();
            try
            {
                var affected = await connection.ExecuteAsync(new CommandDefinition("""
                    UPDATE log.ShipmentMain SET bookingStatus = 0, plannedCollection = NULL, trackingNumber = NULL
                    WHERE shipmentID = @shipmentId AND ISNULL(shipmentCancelled, 0) = 0 AND ISNULL(bookingStatus, 0) = 1 AND ISNULL(collectionStatus, 0) = 0
                    """, new { shipmentId }, transaction, cancellationToken: ct));
                if (affected == 0) throw new InvalidOperationException("Not currently booked and awaiting collection.");

                await connection.ExecuteAsync(new CommandDefinition(
                    "DELETE FROM log.ShipmentCost WHERE shipmentID = @shipmentId AND ISNULL(migoStatus, 0) = 0",
                    new { shipmentId }, transaction, cancellationToken: ct));

                transaction.Commit();

                await WriteShipmentEventAsync(connection, shipmentId, "CORRECTION",
                    $"Unbooked by {actor ?? "unknown"}: expected costs cleared, planned collection and tracking number reset.", ct);
                completed.Add(shipmentId);
            }
            catch (Exception ex)
            {
                try { transaction.Rollback(); } catch { /* already rolled back */ }
                failed.Add(new BulkActionFailure(shipmentId, ex.Message));
            }
        }

        if (completed.Count == 0) throw new NexusConflictException("No shipments were unbooked.");
        return new BulkActionOutcome(completed, failed);
    }

    // ── Cancel ────────────────────────────────────────────────────────

    internal static async Task<int> CancelAsync(INexusOperationsDb db, List<long> shipmentIds, CancellationToken ct)
    {
        if (shipmentIds.Count == 0) throw new NexusValidationException("Select at least one shipment before cancelling.");

        using var connection = await db.CreateConnectionAsync(ct);
        using var transaction = connection.BeginTransaction();
        try
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "DELETE FROM log.ShipmentLink WHERE shipmentID IN @shipmentIds", new { shipmentIds }, transaction, cancellationToken: ct));

            var updated = await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE log.ShipmentMain SET shipmentCancelled = 1
                WHERE shipmentID IN @shipmentIds AND ISNULL(shipmentCancelled, 0) = 0
                """, new { shipmentIds }, transaction, cancellationToken: ct));

            transaction.Commit();
            return updated;
        }
        catch
        {
            transaction.Rollback();
            throw;
        }
    }

    // ── Planned collection / events ──────────────────────────────────

    internal static async Task UpdatePlannedCollectionAsync(INexusOperationsDb db, IDataChangeLogService dataChangeLog, List<long> shipmentIds, DateTime date, string? actor, CancellationToken ct)
    {
        if (shipmentIds.Count == 0) throw new NexusValidationException("No shipments selected.");

        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.ShipmentMain SET plannedCollection = @date
            WHERE shipmentID IN @shipmentIds AND ISNULL(shipmentCancelled, 0) = 0
            """, new { shipmentIds, date }, cancellationToken: ct));

        await dataChangeLog.StampAsync(actor, "ShipmentMain", ct);
    }

    internal static async Task WriteEventsAsync(INexusOperationsDb db, List<ShipmentEventEntry> events, CancellationToken ct)
    {
        if (events.Count == 0) throw new NexusValidationException("events array required.");

        using var connection = await db.CreateConnectionAsync(ct);
        foreach (var e in events)
        {
            if (e.ShipmentId <= 0 || string.IsNullOrEmpty(e.Category) || string.IsNullOrEmpty(e.Description)) continue;
            await WriteShipmentEventAsync(connection, e.ShipmentId, e.Category, e.Description, ct);
        }
    }

    internal static async Task<IReadOnlyList<ShipmentEventRow>> GetEventsAsync(INexusOperationsDb db, long shipmentId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ShipmentEventRow>(new CommandDefinition("""
            SELECT EventID AS EventId, shipmentID AS ShipmentId, eventCategory AS EventCategory, eventDescription AS EventDescription, timeStamp AS TimeStamp
            FROM log.ShipmentEvents WHERE shipmentID = @shipmentId ORDER BY timeStamp DESC
            """, new { shipmentId }, cancellationToken: ct));
        return rows.AsList();
    }

    // ── Create ────────────────────────────────────────────────────────

    internal static async Task<CreateShipmentResult> CreateFromDeliveriesAsync(INexusOperationsDb db, IOptions<LogisticsOptions> options, IDataChangeLogService dataChangeLog, CreateFromDeliveriesRequest body, string? actor, CancellationToken ct)
    {
        var deliveryIds = body.DeliveryIds.Where(id => id > 0).Distinct().ToList();
        if (deliveryIds.Count == 0)
            throw new NexusValidationException("Select at least one delivery before creating a shipment.");

        using var connection = await db.CreateConnectionAsync(ct);
        using var transaction = connection.BeginTransaction(System.Data.IsolationLevel.Serializable);
        long shipmentId;
        try
        {
            var deliveries = (await connection.QueryAsync<ShipmentSourceDeliveryRow>(new CommandDefinition("""
                SELECT dm.deliveryID AS DeliveryId, dm.customerID AS CustomerId, dm.incoterms AS Incoterms,
                    d.destinationName AS DestinationName, d.destinationStreet AS DestinationStreet, d.destinationCity AS DestinationCity,
                    d.destinationPostCode AS DestinationPostCode, d.destinationCountry AS DestinationCountry, d.defaultIncoterms AS DefaultIncoterms,
                    CAST(ISNULL(dm.netWeight, 0) AS decimal(18,3)) AS NetWeight, CAST(ISNULL(dm.grossWeight, 0) AS decimal(18,3)) AS GrossWeight,
                    CAST(ISNULL(dm.palletCount, 0) AS decimal(18,3)) AS PalletCount, CAST(ISNULL(dm.deliveryVolume, 0) AS decimal(18,3)) AS DeliveryVolume
                FROM log.DeliveryMain dm
                LEFT JOIN log.Destinations d ON d.destinationID = dm.customerID
                LEFT JOIN log.ShipmentLink sl ON sl.deliveryID = dm.deliveryID
                WHERE dm.deliveryID IN @deliveryIds AND dm.completionStatus = 1
                    AND ISNULL(dm.deliveryCancelled, 0) = 0 AND ISNULL(dm.pendingPackagingData, 0) = 0 AND sl.deliveryID IS NULL
                ORDER BY dm.deliveryID ASC
                """, new { deliveryIds }, transaction, cancellationToken: ct))).ToList();

            if (deliveries.Count != deliveryIds.Count)
                throw new InvalidOperationException("One or more deliveries are no longer available for shipment creation. Please refresh and try again.");

            var customerIds = deliveries.Select(d => d.CustomerId).Distinct().ToList();
            if (customerIds.Count != 1)
                throw new InvalidOperationException("Selected deliveries must all belong to the same customer.");

            var effectiveIncoterms = deliveries.Select(d => (d.Incoterms ?? d.DefaultIncoterms ?? "").Trim().ToUpperInvariant()).ToList();
            var uniqueIncoterms = effectiveIncoterms.Where(t => t.Length > 0).Distinct().ToList();
            if (uniqueIncoterms.Count > 1)
            {
                var detail = string.Join(", ", deliveries.Select(d => $"#{d.DeliveryId} → {(d.Incoterms ?? d.DefaultIncoterms ?? "?").ToUpperInvariant()}"));
                throw new NexusValidationException($"Deliveries have conflicting incoterms ({string.Join(" vs ", uniqueIncoterms)}): {detail}. All deliveries in a shipment must share the same incoterms.");
            }

            var first = deliveries[0];
            var settings = options.Value;
            var totals = deliveries.Aggregate((NetWeight: 0m, GrossWeight: 0m, PalletCount: 0m, ShipmentVolume: 0m),
                (acc, d) => (acc.NetWeight + d.NetWeight, acc.GrossWeight + d.GrossWeight, acc.PalletCount + d.PalletCount, acc.ShipmentVolume + d.DeliveryVolume));

            var destinationName = (body.DestinationName ?? first.DestinationName ?? "").Trim();
            var destinationStreet = (body.DestinationStreet ?? first.DestinationStreet ?? "").Trim();
            var destinationCity = (body.DestinationCity ?? first.DestinationCity ?? "").Trim();
            var destinationPostCode = (body.DestinationPostCode ?? first.DestinationPostCode ?? "").Trim();
            var destinationCountry = (body.DestinationCountry ?? first.DestinationCountry ?? "").Trim();
            var incoTerms = (body.IncoTerms ?? effectiveIncoterms.FirstOrDefault() ?? "").Trim();

            shipmentId = await connection.QuerySingleAsync<long>(new CommandDefinition("""
                INSERT INTO log.ShipmentMain
                    (originID, originName, originStreet, originCity, originPostCode, originCountry,
                     destinationID, destinationName, destinationStreet, destinationCity, destinationPostCode, destinationCountry,
                     netWeight, grossWeight, palletCount, shipmentVolume,
                     plannedCollection, actualCollection, collectionStatus, forwarderID, trackingNumber, incoTerms, customsRequired, customsComplete, shipmentCancelled)
                VALUES
                    (@originId, @originName, @originStreet, @originCity, @originPostCode, @originCountry,
                     @destinationId, @destinationName, @destinationStreet, @destinationCity, @destinationPostCode, @destinationCountry,
                     @netWeight, @grossWeight, @palletCount, @shipmentVolume,
                     @plannedCollection, @actualCollection, @collectionStatus, @forwarderId, @trackingNumber, @incoTerms, @customsRequired, @customsComplete, @shipmentCancelled);
                SELECT CAST(SCOPE_IDENTITY() AS BIGINT);
                """, new
            {
                originId = settings.OriginId, originName = settings.OriginName, originStreet = settings.OriginStreet, originCity = settings.OriginCity, originPostCode = settings.OriginPostCode, originCountry = settings.OriginCountry,
                destinationId = first.CustomerId, destinationName, destinationStreet, destinationCity, destinationPostCode, destinationCountry,
                netWeight = totals.NetWeight, grossWeight = totals.GrossWeight, palletCount = totals.PalletCount, shipmentVolume = totals.ShipmentVolume,
                body.PlannedCollection, body.ActualCollection, body.CollectionStatus, forwarderId = body.ForwarderId, trackingNumber = (body.TrackingNumber ?? "").Trim(),
                incoTerms, body.CustomsRequired, body.CustomsComplete, body.ShipmentCancelled,
            }, transaction, cancellationToken: ct));

            foreach (var deliveryId in deliveryIds)
            {
                await connection.ExecuteAsync(new CommandDefinition(
                    "INSERT INTO log.ShipmentLink (shipmentID, deliveryID) VALUES (@shipmentId, @deliveryId)",
                    new { shipmentId, deliveryId }, transaction, cancellationToken: ct));
            }

            transaction.Commit();
        }
        catch
        {
            transaction.Rollback();
            throw;
        }

        await dataChangeLog.StampAsync(actor, "ShipmentMain", ct);
        await WriteShipmentEventAsync(connection, shipmentId, "CREATED",
            $"Shipment created by {actor ?? "unknown"} from {deliveryIds.Count} deliver{(deliveryIds.Count != 1 ? "ies" : "y")}: {string.Join(", ", deliveryIds)}", ct);

        var shipment = await GetShipmentByIdAsync(connection, shipmentId, ct) ?? throw new InvalidOperationException("Shipment vanished immediately after creation.");
        var folder = GetShipmentFolderInfo(shipment, options.Value);
        return new CreateShipmentResult(shipmentId, FormatShipmentRef(shipmentId), deliveryIds.Count, IsExWorks(shipment.IncoTerms), folder.ShipmentPath, shipment);
    }

    private sealed record ShipmentSourceDeliveryRow(long DeliveryId, long? CustomerId, string? Incoterms, string? DestinationName, string? DestinationStreet, string? DestinationCity, string? DestinationPostCode, string? DestinationCountry, string? DefaultIncoterms, decimal NetWeight, decimal GrossWeight, decimal PalletCount, decimal DeliveryVolume);

    internal static async Task<CreateManualShipmentResult> CreateManualAsync(INexusOperationsDb db, IOptions<LogisticsOptions> options, IDataChangeLogService dataChangeLog, CreateManualShipmentRequest body, string? actor, CancellationToken ct)
    {
        if (body.DestinationId <= 0)
            throw new NexusValidationException("Select a destination before creating a manual shipment.");

        using var connection = await db.CreateConnectionAsync(ct);
        var dest = await connection.QuerySingleOrDefaultAsync<(string? DestinationName, string? DestinationStreet, string? DestinationCity, string? DestinationPostCode, string? DestinationCountry, string? DefaultIncoterms)?>(new CommandDefinition(
            "SELECT destinationName, destinationStreet, destinationCity, destinationPostCode, destinationCountry, defaultIncoterms FROM log.Destinations WHERE destinationID = @destinationId",
            new { body.DestinationId }, cancellationToken: ct));
        if (dest is null) throw new NexusValidationException("Destination not found.");

        var settings = options.Value;
        var destinationName = (body.DestinationName ?? dest.Value.DestinationName ?? "").Trim();
        var destinationStreet = (body.DestinationStreet ?? dest.Value.DestinationStreet ?? "").Trim();
        var destinationCity = (body.DestinationCity ?? dest.Value.DestinationCity ?? "").Trim();
        var destinationPostCode = (body.DestinationPostCode ?? dest.Value.DestinationPostCode ?? "").Trim();
        var destinationCountry = (body.DestinationCountry ?? dest.Value.DestinationCountry ?? "").Trim();
        var incoTerms = (body.IncoTerms ?? dest.Value.DefaultIncoterms ?? "").Trim();

        var shipmentId = await connection.QuerySingleAsync<long>(new CommandDefinition("""
            INSERT INTO log.ShipmentMain
                (originID, originName, originStreet, originCity, originPostCode, originCountry,
                 destinationID, destinationName, destinationStreet, destinationCity, destinationPostCode, destinationCountry,
                 netWeight, grossWeight, palletCount, shipmentVolume,
                 plannedCollection, collectionStatus, forwarderID, incoTerms, customsRequired, customsComplete, shipmentCancelled, IsManual)
            VALUES
                (@originId, @originName, @originStreet, @originCity, @originPostCode, @originCountry,
                 @destinationId, @destinationName, @destinationStreet, @destinationCity, @destinationPostCode, @destinationCountry,
                 0, 0, 0, 0,
                 @plannedCollection, 0, @forwarderId, @incoTerms, @customsRequired, @customsComplete, 0, 1);
            SELECT CAST(SCOPE_IDENTITY() AS BIGINT);
            """, new
        {
            originId = settings.OriginId, originName = settings.OriginName, originStreet = settings.OriginStreet, originCity = settings.OriginCity, originPostCode = settings.OriginPostCode, originCountry = settings.OriginCountry,
            destinationId = body.DestinationId, destinationName, destinationStreet, destinationCity, destinationPostCode, destinationCountry,
            body.PlannedCollection, forwarderId = body.ForwarderId, incoTerms, body.CustomsRequired, body.CustomsComplete,
        }, cancellationToken: ct));

        await dataChangeLog.StampAsync(actor, "ShipmentMain", ct);
        await WriteShipmentEventAsync(connection, shipmentId, "CREATED", $"Manual shipment created by {actor ?? "unknown"} — {destinationName}", ct);

        var shipment = await GetShipmentByIdAsync(connection, shipmentId, ct) ?? throw new InvalidOperationException("Shipment vanished immediately after creation.");
        return new CreateManualShipmentResult(shipmentId, FormatShipmentRef(shipmentId), shipment);
    }

    // ── Details / delivery membership / corrections ──────────────────

    internal static async Task<ShipmentDetailResult> GetDetailsAsync(INexusOperationsDb db, long shipmentId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var shipment = await GetShipmentByIdAsync(connection, shipmentId, ct) ?? throw new NexusNotFoundException("Shipment not found.");

        var deliveries = await connection.QueryAsync<ShipmentDeliveryRow>(new CommandDefinition("""
            SELECT dm.deliveryID AS DeliveryId, dm.customerID AS CustomerId, dm.deliveryService AS DeliveryService, dm.picksheetComment AS PicksheetComment,
                CAST(ISNULL(dm.netWeight, 0) AS decimal(18,3)) AS NetWeight, CAST(ISNULL(dm.grossWeight, 0) AS decimal(18,3)) AS GrossWeight,
                CAST(ISNULL(dm.palletCount, 0) AS decimal(18,3)) AS PalletCount, CAST(ISNULL(dm.deliveryVolume, 0) AS decimal(18,3)) AS DeliveryVolume,
                d.destinationName AS DestinationName
            FROM log.ShipmentLink sl
            INNER JOIN log.DeliveryMain dm ON dm.deliveryID = sl.deliveryID
            LEFT JOIN log.Destinations d ON d.destinationID = dm.customerID
            WHERE sl.shipmentID = @shipmentId ORDER BY dm.deliveryID ASC
            """, new { shipmentId }, cancellationToken: ct));

        return new ShipmentDetailResult(shipment, deliveries.AsList());
    }

    internal static async Task<RemoveDeliveryResult> RemoveDeliveryAsync(INexusOperationsDb db, long shipmentId, long deliveryId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "DELETE FROM log.ShipmentLink WHERE shipmentID = @shipmentId AND deliveryID = @deliveryId", new { shipmentId, deliveryId }, cancellationToken: ct));

        var remaining = await connection.QuerySingleAsync<int>(new CommandDefinition(
            "SELECT COUNT(*) FROM log.ShipmentLink WHERE shipmentID = @shipmentId", new { shipmentId }, cancellationToken: ct));

        if (remaining == 0)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "UPDATE log.ShipmentMain SET shipmentCancelled = 1 WHERE shipmentID = @shipmentId", new { shipmentId }, cancellationToken: ct));
            return new RemoveDeliveryResult(true);
        }

        await SyncShipmentAggregateDataAsync(connection, shipmentId, ct);
        return new RemoveDeliveryResult(false);
    }

    internal static async Task AddDeliveriesAsync(INexusOperationsDb db, long shipmentId, AddDeliveriesToShipmentRequest body, CancellationToken ct)
    {
        var deliveryIds = body.DeliveryIds.Where(id => id > 0).Distinct().ToList();
        if (deliveryIds.Count == 0) throw new NexusValidationException("No delivery IDs provided.");

        using var connection = await db.CreateConnectionAsync(ct);
        var shipment = await connection.QuerySingleOrDefaultAsync<(long? DestinationId, string? IncoTerms)?>(new CommandDefinition(
            "SELECT destinationID, incoTerms FROM log.ShipmentMain WHERE shipmentID = @shipmentId AND ISNULL(shipmentCancelled, 0) = 0",
            new { shipmentId }, cancellationToken: ct));
        if (shipment is null) throw new NexusNotFoundException("Shipment not found or cancelled.");

        var available = (await connection.QueryAsync<(long DeliveryId, long? CustomerId, string? Incoterms, string? DefaultIncoterms)>(new CommandDefinition("""
            SELECT dm.deliveryID AS DeliveryId, dm.customerID AS CustomerId, dm.incoterms AS Incoterms, d.defaultIncoterms AS DefaultIncoterms
            FROM log.DeliveryMain dm
            LEFT JOIN log.Destinations d ON d.destinationID = dm.customerID
            LEFT JOIN log.ShipmentLink sl ON sl.deliveryID = dm.deliveryID
            WHERE dm.deliveryID IN @deliveryIds AND dm.completionStatus = 1
                AND ISNULL(dm.deliveryCancelled, 0) = 0 AND ISNULL(dm.pendingPackagingData, 0) = 0 AND sl.deliveryID IS NULL
            """, new { deliveryIds }, cancellationToken: ct))).ToList();

        if (available.Count != deliveryIds.Count)
            throw new NexusValidationException("One or more deliveries are unavailable (already shipped, incomplete, or cancelled).");

        if (available.Any(d => d.CustomerId != shipment.Value.DestinationId))
            throw new NexusValidationException("All deliveries must belong to the same customer as the shipment.");

        var shipmentTerms = (shipment.Value.IncoTerms ?? "").Trim().ToUpperInvariant();
        if (shipmentTerms.Length > 0)
        {
            var conflicting = available.Where(d =>
            {
                var effective = (d.Incoterms ?? d.DefaultIncoterms ?? "").Trim().ToUpperInvariant();
                return effective.Length > 0 && effective != shipmentTerms;
            }).ToList();
            if (conflicting.Count > 0)
            {
                var detail = string.Join(", ", conflicting.Select(d => $"#{d.DeliveryId} ({(d.Incoterms ?? d.DefaultIncoterms ?? "?").ToUpperInvariant()})"));
                throw new NexusValidationException($"Incoterms mismatch: shipment is {shipmentTerms} but {detail} differ. Only deliveries with matching incoterms can be added.");
            }
        }

        foreach (var deliveryId in deliveryIds)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "INSERT INTO log.ShipmentLink (shipmentID, deliveryID) VALUES (@shipmentId, @deliveryId)", new { shipmentId, deliveryId }, cancellationToken: ct));
        }

        await SyncShipmentAggregateDataAsync(connection, shipmentId, ct);
    }

    internal static async Task UpdateStatusDatesAsync(INexusOperationsDb db, long shipmentId, UpdateStatusDatesRequest body, string? actor, CancellationToken ct)
    {
        var sets = new List<string>();
        var parameters = new DynamicParameters();
        parameters.Add("shipmentId", shipmentId);

        void AddBit(string col, bool? value)
        {
            if (value is null) return;
            parameters.Add(col, value.Value);
            sets.Add($"{col} = @{col}");
        }
        void AddDate(string col, DateTime? value, bool present)
        {
            if (!present) return;
            parameters.Add(col, value);
            sets.Add($"{col} = @{col}");
        }

        AddBit("bookingStatus", body.BookingStatus);
        AddDate("plannedCollection", body.PlannedCollection, body.PlannedCollection is not null);
        AddBit("collectionStatus", body.CollectionStatus);
        AddDate("actualCollection", body.ActualCollection, body.ActualCollection is not null);
        if (body.CollectionStatus == true && body.ActualCollection is null)
            sets.Add("actualCollection = COALESCE(actualCollection, GETDATE())");

        AddDate("plannedDelivery", body.PlannedDelivery, body.PlannedDeliverySet == true || body.PlannedDelivery is not null);
        AddBit("deliveryStatus", body.DeliveryStatus);
        AddDate("actualDelivery", body.ActualDelivery, body.ActualDelivery is not null);
        if (body.DeliveryStatus == true && body.ActualDelivery is null)
            sets.Add("actualDelivery = COALESCE(actualDelivery, GETDATE())");

        if (sets.Count == 0) throw new NexusValidationException("Nothing to update");

        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            $"UPDATE log.ShipmentMain SET {string.Join(", ", sets)} WHERE shipmentID = @shipmentId", parameters, cancellationToken: ct));

        await WriteShipmentEventAsync(connection, shipmentId, "CORRECTION",
            $"Dates/status corrected by {actor ?? "unknown"}: {string.Join(", ", sets.Select(s => s.Split(" = ")[0]))}", ct);
    }

    internal static async Task UpdateForwarderAsync(INexusOperationsDb db, long shipmentId, long? forwarderId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.ShipmentMain SET forwarderID = @forwarderId
            WHERE shipmentID = @shipmentId AND ISNULL(shipmentCancelled, 0) = 0
            """, new { shipmentId, forwarderId }, cancellationToken: ct));
    }

    // ── Search ────────────────────────────────────────────────────────

    /// <summary>
    /// Outbound leg only — Node's real /search UNIONs this with an inbound
    /// leg against log.PurchaseOrderShipment (+PurchaseOrderSuggestion,
    /// Vendor), none of which are ported yet (that table belongs to the
    /// not-yet-scoped Purchasing/Performance sub-phase, 8b). Deliberately
    /// deferred rather than guessed at: a search that only ever returns
    /// outbound results is a real, honest reduction in functionality, not
    /// a silent correctness bug — wire in the inbound leg once 8b lands.
    /// deliveryNumber is an outbound-only concept in Node too (the inbound
    /// leg forces 1=0 for it), so this port already matches Node's own
    /// behavior there without needing the inbound table at all.
    /// </summary>
    internal static async Task<IReadOnlyList<ShipmentSearchRow>> SearchAsync(INexusOperationsDb db, ShipmentSearchQuery query, CancellationToken ct)
    {
        var where = new List<string> { "ISNULL(sm.shipmentCancelled, 0) = 0" };
        var parameters = new DynamicParameters();

        if (!string.IsNullOrWhiteSpace(query.ShipmentRef) && long.TryParse(query.ShipmentRef.Trim(), out var shipmentRef))
        {
            parameters.Add("shipmentRef", shipmentRef);
            where.Add("sm.shipmentID = @shipmentRef");
        }
        if (!string.IsNullOrWhiteSpace(query.Customer))
        {
            parameters.Add("customer", $"%{query.Customer.Trim()}%");
            where.Add("sm.destinationName LIKE @customer");
        }
        if (!string.IsNullOrWhiteSpace(query.Forwarder))
        {
            parameters.Add("forwarder", $"%{query.Forwarder.Trim()}%");
            where.Add("EXISTS (SELECT 1 FROM log.Forwarders f WHERE f.forwarderID = sm.forwarderID AND f.forwarderName LIKE @forwarder)");
        }
        if (!string.IsNullOrWhiteSpace(query.Tracking))
        {
            parameters.Add("tracking", $"%{query.Tracking.Trim()}%");
            where.Add("sm.trackingNumber LIKE @tracking");
        }
        if (!string.IsNullOrWhiteSpace(query.DeliveryNumber) && long.TryParse(query.DeliveryNumber.Trim(), out var deliveryNumber))
        {
            parameters.Add("deliveryNumber", deliveryNumber);
            where.Add("EXISTS (SELECT 1 FROM log.ShipmentLink sl WHERE sl.shipmentID = sm.shipmentID AND sl.deliveryID = @deliveryNumber)");
        }

        var dateCol = query.DateField switch
        {
            "plannedCollection" => "sm.plannedCollection",
            "actualCollection" => "sm.actualCollection",
            "plannedDelivery" => "sm.plannedDelivery",
            "actualDelivery" => "sm.actualDelivery",
            _ => null,
        };
        if (dateCol is not null)
        {
            if (query.DateFrom is not null) { parameters.Add("dateFrom", query.DateFrom); where.Add($"{dateCol} >= @dateFrom"); }
            if (query.DateTo is not null) { parameters.Add("dateTo", query.DateTo); where.Add($"{dateCol} <= @dateTo"); }
        }

        var active = where.Count > 1;
        if (!active) throw new NexusValidationException("Please provide at least one search term.");

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<(long ShipmentId, string? DestinationName, DateTime? PlannedCollection, DateTime? ActualCollection, DateTime? PlannedDelivery, DateTime? ActualDelivery, string? TrackingNumber, string? IncoTerms, long? ForwarderId, bool BookingStatus, bool CollectionStatus, bool DeliveryStatus, bool ShipmentCancelled, string? ForwarderName)>(new CommandDefinition($"""
            SELECT
                sm.shipmentID AS ShipmentId, sm.destinationName AS DestinationName,
                sm.plannedCollection AS PlannedCollection, sm.actualCollection AS ActualCollection,
                sm.PlannedDelivery AS PlannedDelivery, sm.ActualDelivery AS ActualDelivery,
                sm.trackingNumber AS TrackingNumber, sm.incoTerms AS IncoTerms, sm.forwarderID AS ForwarderId,
                CAST(ISNULL(sm.bookingStatus, 0) AS bit) AS BookingStatus,
                CAST(ISNULL(sm.collectionStatus, 0) AS bit) AS CollectionStatus,
                CAST(ISNULL(sm.DeliveryStatus, 0) AS bit) AS DeliveryStatus,
                CAST(ISNULL(sm.shipmentCancelled, 0) AS bit) AS ShipmentCancelled,
                (SELECT TOP 1 f.forwarderName FROM log.Forwarders f WHERE f.forwarderID = sm.forwarderID) AS ForwarderName
            FROM log.ShipmentMain sm
            WHERE {string.Join(" AND ", where)}
            ORDER BY sm.shipmentID DESC
            """, parameters, cancellationToken: ct));

        var results = rows.Select(r =>
        {
            var sortDate = r.ActualDelivery ?? r.PlannedDelivery ?? r.ActualCollection ?? r.PlannedCollection;
            return new ShipmentSearchRow($"O:{r.ShipmentId}", "outbound", r.ShipmentId, r.ShipmentId.ToString("D8"), r.DestinationName, r.ForwarderName,
                r.IncoTerms, r.PlannedCollection, r.ActualCollection, r.PlannedDelivery, r.ActualDelivery, r.TrackingNumber,
                r.BookingStatus, r.CollectionStatus, r.DeliveryStatus, r.ShipmentCancelled, sortDate);
        }).OrderByDescending(r => r.SortDate ?? DateTime.MinValue).ToList();

        return results;
    }

    // ── Shared helpers ────────────────────────────────────────────────

    internal static async Task<ShipmentRow?> GetShipmentByIdAsync(SqlConnection connection, long shipmentId, CancellationToken ct)
    {
        var row = await connection.QuerySingleOrDefaultAsync<ShipmentRawRow>(new CommandDefinition(
            "SELECT * FROM log.ShipmentMain WHERE shipmentID = @shipmentId", new { shipmentId }, cancellationToken: ct));
        if (row is null) return null;

        string? forwarderName = null;
        if (row.forwarderID is not null)
        {
            forwarderName = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
                "SELECT TOP 1 forwarderName FROM log.Forwarders WHERE forwarderID = @forwarderId", new { forwarderId = row.forwarderID }, cancellationToken: ct));
        }

        return new ShipmentRow(
            row.shipmentID, row.originID, row.originName, row.originStreet, row.originCity, row.originPostCode, row.originCountry,
            row.destinationID, row.destinationName, row.destinationStreet, row.destinationCity, row.destinationPostCode, row.destinationCountry,
            row.netWeight, row.grossWeight, row.palletCount, row.shipmentVolume,
            row.plannedCollection, row.actualCollection, row.collectionStatus ?? false,
            row.forwarderID, row.trackingNumber, row.incoTerms, row.customsRequired ?? false, row.customsComplete ?? false, row.shipmentCancelled ?? false,
            row.PlannedDelivery, row.ActualDelivery, row.DeliveryStatus ?? false, row.bookingStatus ?? false, row.customsID, row.IsManual ?? false,
            forwarderName ?? "", null, null);
    }

    // Dapper needs a concrete shape to bind SELECT * against — property
    // names match log.ShipmentMain's real column casing exactly (Dapper
    // binds case-insensitively, but the mixed PascalCase/camelCase in the
    // real schema, e.g. PlannedDelivery vs plannedCollection, is preserved
    // here just for clarity against the DDL).
#pragma warning disable IDE1006
    private sealed class ShipmentRawRow
    {
        public long shipmentID { get; set; }
        public long? originID { get; set; }
        public string? originName { get; set; }
        public string? originStreet { get; set; }
        public string? originCity { get; set; }
        public string? originPostCode { get; set; }
        public string? originCountry { get; set; }
        public long? destinationID { get; set; }
        public string? destinationName { get; set; }
        public string? destinationStreet { get; set; }
        public string? destinationCity { get; set; }
        public string? destinationPostCode { get; set; }
        public string? destinationCountry { get; set; }
        public decimal? netWeight { get; set; }
        public decimal? grossWeight { get; set; }
        public decimal? palletCount { get; set; }
        public decimal? shipmentVolume { get; set; }
        public DateTime? plannedCollection { get; set; }
        public DateTime? actualCollection { get; set; }
        public bool? collectionStatus { get; set; }
        public long? forwarderID { get; set; }
        public string? trackingNumber { get; set; }
        public string? incoTerms { get; set; }
        public bool? customsRequired { get; set; }
        public bool? customsComplete { get; set; }
        public bool? shipmentCancelled { get; set; }
        public DateTime? PlannedDelivery { get; set; }
        public DateTime? ActualDelivery { get; set; }
        public bool? DeliveryStatus { get; set; }
        public bool? bookingStatus { get; set; }
        public string? customsID { get; set; }
        public bool? IsManual { get; set; }
    }
#pragma warning restore IDE1006

    internal static async Task WriteShipmentEventAsync(SqlConnection connection, long shipmentId, string category, string description, CancellationToken ct)
    {
        await connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO log.ShipmentEvents (shipmentID, eventCategory, eventDescription) VALUES (@shipmentId, @category, @description)
            """, new { shipmentId, category, description }, cancellationToken: ct));
    }

    /// <summary>
    /// Full shipment + linked deliveries/pallets (or, for a Manual Outbound
    /// Shipment, ManualCargo instead) — mirrors Node's getShipmentContext
    /// exactly. Needed by PDF generation (8a.3), which is the first real
    /// caller — 8a.1/8a.2's own callers only ever needed the plain
    /// shipment row (GetShipmentByIdAsync) or discarded
    /// SyncShipmentAggregateDataAsync's return value entirely.
    /// </summary>
    internal static async Task<ShipmentContext> GetShipmentContextAsync(SqlConnection connection, long shipmentId, CancellationToken ct)
    {
        var shipment = await GetShipmentByIdAsync(connection, shipmentId, ct) ?? throw new NexusNotFoundException($"Shipment {shipmentId} not found.");

        if (shipment.IsManual)
        {
            var manualCargo = await connection.QueryAsync<ManualCargoItemRow>(new CommandDefinition("""
                SELECT CargoID AS CargoId, ShipmentID AS ShipmentId, Description, PackageCount, Weight, Length, Width, Height, Volume, CreatedAtUtc, CreatedBy
                FROM log.ManualCargoItem WHERE ShipmentID = @shipmentId AND Removed = 0 ORDER BY CargoID ASC
                """, new { shipmentId }, cancellationToken: ct));
            return new ShipmentContext(shipment, [], [], manualCargo.AsList());
        }

        var deliveries = await connection.QueryAsync<ShipmentContextDeliveryRow>(new CommandDefinition("""
            SELECT dm.deliveryID AS DeliveryId, dm.customerID AS CustomerId, dm.dispatchDate AS DispatchDate, dm.completionDate AS CompletionDate,
                dm.deliveryService AS DeliveryService, dm.picksheetComment AS PicksheetComment,
                CAST(ISNULL(dm.netWeight, 0) AS decimal(18,3)) AS NetWeight, CAST(ISNULL(dm.grossWeight, 0) AS decimal(18,3)) AS GrossWeight,
                CAST(ISNULL(dm.palletCount, 0) AS decimal(18,3)) AS PalletCount, CAST(ISNULL(dm.deliveryVolume, 0) AS decimal(18,3)) AS DeliveryVolume,
                d.destinationName AS DestinationName, d.destinationStreet AS DestinationStreet, d.destinationCity AS DestinationCity,
                d.destinationPostCode AS DestinationPostCode, d.destinationCountry AS DestinationCountry,
                STUFF((SELECT '; ' + e.address FROM log.Email e WHERE e.ID = dm.customerID FOR XML PATH('')), 1, 2, '') AS DestinationEmail
            FROM log.ShipmentLink sl
            INNER JOIN log.DeliveryMain dm ON dm.deliveryID = sl.deliveryID
            LEFT JOIN log.Destinations d ON dm.customerID = d.destinationID
            WHERE sl.shipmentID = @shipmentId ORDER BY dm.deliveryID ASC
            """, new { shipmentId }, cancellationToken: ct));

        var pallets = await connection.QueryAsync<ShipmentContextPalletRow>(new CommandDefinition("""
            SELECT sl.deliveryID AS DeliveryId, pm.palletID AS PalletId, pm.palletType AS PalletType, pm.palletFinish AS PalletFinish,
                CAST(ISNULL(pm.packagingWeight, 0) AS decimal(18,3)) AS PackagingWeight, CAST(ISNULL(pm.grossWeight, 0) AS decimal(18,3)) AS GrossWeight,
                CAST(ISNULL(pm.palletVolume, 0) AS decimal(18,3)) AS PalletVolume, pm.palletLength AS PalletLength, pm.palletWidth AS PalletWidth,
                pm.palletHeight AS PalletHeight, pm.palletLocation AS PalletLocation
            FROM log.ShipmentLink sl
            INNER JOIN log.DeliveryLink dl ON dl.deliveryID = sl.deliveryID
            INNER JOIN log.PalletMain pm ON pm.palletID = dl.palletID
            WHERE sl.shipmentID = @shipmentId AND ISNULL(pm.palletRemoved, 0) = 0
            ORDER BY sl.deliveryID ASC, pm.palletID ASC
            """, new { shipmentId }, cancellationToken: ct));

        return new ShipmentContext(shipment, deliveries.AsList(), pallets.AsList(), []);
    }

    /// <summary>
    /// Recomputes ShipmentMain's (and each linked DeliveryMain's) stored
    /// aggregate weight/pallet-count/volume columns from PalletMain — or,
    /// for a Manual Outbound Shipment, from ManualCargoItem instead (see
    /// RecalcManualShipmentTotalsAsync). Returns the freshly-synced context
    /// (matching Node's own return-getShipmentContext-at-the-end shape) —
    /// 8a.1's own two callers (delivery add/remove) still just discard it.
    /// </summary>
    internal static async Task<ShipmentContext> SyncShipmentAggregateDataAsync(SqlConnection connection, long shipmentId, CancellationToken ct)
    {
        var isManual = await connection.QuerySingleOrDefaultAsync<bool?>(new CommandDefinition(
            "SELECT IsManual FROM log.ShipmentMain WHERE shipmentID = @shipmentId", new { shipmentId }, cancellationToken: ct));
        if (isManual == true)
        {
            await RecalcManualShipmentTotalsAsync(connection, shipmentId, ct);
            return await GetShipmentContextAsync(connection, shipmentId, ct);
        }

        using var transaction = connection.BeginTransaction();
        try
        {
            var deliveryIds = (await connection.QueryAsync<long>(new CommandDefinition(
                "SELECT deliveryID FROM log.ShipmentLink WHERE shipmentID = @shipmentId", new { shipmentId }, transaction, cancellationToken: ct))).ToList();

            var pallets = await connection.QueryAsync<(long DeliveryId, decimal PackagingWeight, decimal GrossWeight, decimal PalletVolume)>(new CommandDefinition("""
                SELECT sl.deliveryID AS DeliveryId,
                    CAST(ISNULL(pm.packagingWeight, 0) AS decimal(18,3)) AS PackagingWeight,
                    CAST(ISNULL(pm.grossWeight, 0) AS decimal(18,3)) AS GrossWeight,
                    CAST(ISNULL(pm.palletVolume, 0) AS decimal(18,3)) AS PalletVolume
                FROM log.ShipmentLink sl
                INNER JOIN log.DeliveryLink dl ON dl.deliveryID = sl.deliveryID
                INNER JOIN log.PalletMain pm ON pm.palletID = dl.palletID
                WHERE sl.shipmentID = @shipmentId AND ISNULL(pm.palletRemoved, 0) = 0
                ORDER BY sl.deliveryID ASC, pm.palletID ASC
                """, new { shipmentId }, transaction, cancellationToken: ct));

            var deliveryTotals = deliveryIds.ToDictionary(id => id, _ => (PalletCount: 0m, GrossWeight: 0m, NetWeight: 0m, DeliveryVolume: 0m));
            foreach (var pallet in pallets)
            {
                var totals = deliveryTotals[pallet.DeliveryId];
                deliveryTotals[pallet.DeliveryId] = (
                    totals.PalletCount + 1,
                    totals.GrossWeight + pallet.GrossWeight,
                    totals.NetWeight + (pallet.GrossWeight - pallet.PackagingWeight),
                    totals.DeliveryVolume + pallet.PalletVolume);
            }

            decimal shipmentGrossWeight = 0, shipmentNetWeight = 0, shipmentPalletCount = 0, shipmentVolume = 0;
            foreach (var (deliveryId, totals) in deliveryTotals)
            {
                shipmentGrossWeight += totals.GrossWeight;
                shipmentNetWeight += totals.NetWeight;
                shipmentPalletCount += totals.PalletCount;
                shipmentVolume += totals.DeliveryVolume;

                await connection.ExecuteAsync(new CommandDefinition("""
                    UPDATE log.DeliveryMain SET palletCount = @palletCount, grossWeight = @grossWeight, netWeight = @netWeight, deliveryVolume = @deliveryVolume
                    WHERE deliveryID = @deliveryId
                    """, new { deliveryId, palletCount = Math.Round(totals.PalletCount, 3), grossWeight = Math.Round(totals.GrossWeight, 3), netWeight = Math.Round(totals.NetWeight, 3), deliveryVolume = Math.Round(totals.DeliveryVolume, 3) }, transaction, cancellationToken: ct));
            }

            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE log.ShipmentMain SET palletCount = @palletCount, grossWeight = @grossWeight, netWeight = @netWeight, shipmentVolume = @shipmentVolume
                WHERE shipmentID = @shipmentId
                """, new { shipmentId, palletCount = Math.Round(shipmentPalletCount, 3), grossWeight = Math.Round(shipmentGrossWeight, 3), netWeight = Math.Round(shipmentNetWeight, 3), shipmentVolume = Math.Round(shipmentVolume, 3) }, transaction, cancellationToken: ct));

            transaction.Commit();
        }
        catch
        {
            transaction.Rollback();
            throw;
        }

        return await GetShipmentContextAsync(connection, shipmentId, ct);
    }

    /// <summary>netWeight is set equal to grossWeight for manual cargo — entry only asks for one weight per line, there's no separate tare/net concept the way SAP delivery data has.</summary>
    private static async Task RecalcManualShipmentTotalsAsync(SqlConnection connection, long shipmentId, CancellationToken ct)
    {
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.ShipmentMain SET
                grossWeight = t.totalWeight, netWeight = t.totalWeight, palletCount = t.totalPackages, shipmentVolume = t.totalVolume
            FROM log.ShipmentMain sm
            CROSS APPLY (
                SELECT ISNULL(SUM(Weight), 0) AS totalWeight, ISNULL(SUM(PackageCount), 0) AS totalPackages, ISNULL(SUM(Volume), 0) AS totalVolume
                FROM log.ManualCargoItem WHERE ShipmentID = sm.shipmentID AND Removed = 0
            ) t
            WHERE sm.shipmentID = @shipmentId
            """, new { shipmentId }, cancellationToken: ct));
    }

    internal static string FormatShipmentRef(long shipmentId) => shipmentId.ToString("D8");

    internal static bool IsExWorks(string? incoTerms) =>
        (incoTerms ?? "").Trim().ToUpperInvariant() is "EXW" or "EX WORKS";

    internal static string SanitizeFolderSegment(string? value)
    {
        var clean = System.Text.RegularExpressions.Regex.Replace(value ?? "Unknown Customer", "[<>:\"/\\\\|?*]", "_");
        clean = System.Text.RegularExpressions.Regex.Replace(clean, @"[. ]+$", "").Trim();
        return clean.Length > 0 ? clean : "Unknown Customer";
    }

    /// <summary>Throws if the configured export root doesn't look like a real Windows path — the same "misconfigured LOGISTICS_EXPORT_ROOT" guard Node has, catching a stray machine environment variable shadowing the real config before it produces a nonsensical folder path.</summary>
    internal static string AssertValidExportRoot(string exportRoot)
    {
        var value = (exportRoot ?? "").Trim();
        var looksValid = System.Text.RegularExpressions.Regex.IsMatch(value, @"^[A-Za-z]:[\\/]") || System.Text.RegularExpressions.Regex.IsMatch(value, @"^\\\\[^?\\]");
        if (!looksValid)
        {
            throw new NexusBadGatewayException(
                $"Logistics export folder path is misconfigured (Logistics:ExportRoot resolved to \"{value}\"). Check appsettings.Production.json's Logistics:ExportRoot.");
        }
        return value;
    }

    internal readonly record struct ShipmentFolderInfo(string ShipmentRef, string CustomerPath, string ShipmentPath);

    internal static ShipmentFolderInfo GetShipmentFolderInfo(ShipmentRow shipment, LogisticsOptions settings)
    {
        var exportRoot = AssertValidExportRoot(settings.ExportRoot);
        var shipmentRef = FormatShipmentRef(shipment.ShipmentId);
        var customerPath = Path.Combine(exportRoot, SanitizeFolderSegment(shipment.DestinationName));
        return new ShipmentFolderInfo(shipmentRef, customerPath, Path.Combine(customerPath, shipmentRef));
    }
}
