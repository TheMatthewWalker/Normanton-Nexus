using Dapper;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Data.SqlClient;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Notifications;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Warehouse;

/// <summary>
/// Staging Post — material requisitions from Production to Stores. Port of
/// routes/staging.js + routes/stagingsql.js. Warehouse Sub-phase 7d.
/// Deliberately mounted with no department/permission gate on its main
/// actions (StagingController), matching Node's own `app.use('/api/staging',
/// requireLogin, stagingRoutes)` exactly — any logged-in user can raise a
/// request (this is how Production floor staff use it), only bin-restriction
/// writes are LOG_SUPER-gated.
///
/// The KPI export (GET /kpi/export, an ExcelJS-generated .xlsx) was NOT
/// ported — matching Finance's own established precedent (dotnet/CLAUDE.md's
/// Phase 5 section) of deliberately deferring server-side spreadsheet export
/// until a real convention is decided for this app, rather than half-guessing
/// one under time pressure. GET /kpi (the underlying data) is ported in full.
/// </summary>
internal static class StagingHelper
{
    private const decimal WithinTolerancePct = 0.10m;

    // ── Materials ─────────────────────────────────────────────────────────

    internal static async Task<IReadOnlyList<StagingMaterialSearchRow>> SearchMaterialsAsync(INexusOperationsDb db, string? search, string? by, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(search)) return [];
        var column = by == "description" ? "MaterialText" : "Material";

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<StagingMaterialSearchRow>(new CommandDefinition($"""
            SELECT TOP 30 Material, MaterialText, Uom
            FROM log.TurnsValClassSnapshot
            WHERE {column} LIKE @search
            ORDER BY Material
            """, new { search = $"%{search}%" }, cancellationToken: ct));
        return rows.AsList();
    }

    // ── Requests — reads ─────────────────────────────────────────────────

    internal static async Task<IReadOnlyList<StagingRequestRow>> ListOpenAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<StagingRequestRow>(new CommandDefinition(
            $"SELECT {RequestColumns} FROM log.StagingRequest WHERE Status = 'Open' ORDER BY DueAtUtc ASC", cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<StagingOpenSummary> GetOpenSummaryAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleAsync<StagingOpenSummary>(new CommandDefinition("""
            SELECT
                COUNT(*) AS OpenCount,
                ISNULL(SUM(CASE WHEN DueAtUtc < GETUTCDATE() THEN 1 ELSE 0 END), 0) AS OverdueCount
            FROM log.StagingRequest WHERE Status = 'Open'
            """, cancellationToken: ct));
    }

    internal static async Task<IReadOnlyList<StagingRequestRow>> ListAllAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<StagingRequestRow>(new CommandDefinition($"""
            SELECT {RequestColumns} FROM log.StagingRequest
            ORDER BY
                CASE WHEN Status = 'Open' THEN 0 ELSE 1 END,
                CASE WHEN Status = 'Open' THEN DueAtUtc END ASC,
                CASE WHEN Status <> 'Open' THEN RequestedAtUtc END DESC
            """, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<IReadOnlyList<StagingRequestRow>> ListCompletedAsync(INexusOperationsDb db, DateTime? from, DateTime? to, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var (whereSql, parameters) = BuildDateRangeWhere("Status IN ('Completed', 'Cancelled')", "RequestedAtUtc", from, to);
        var rows = await connection.QueryAsync<StagingRequestRow>(new CommandDefinition(
            $"SELECT {RequestColumns} FROM log.StagingRequest WHERE {whereSql} ORDER BY RequestedAtUtc DESC", parameters, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<StagingRequestDetail> GetByIdAsync(INexusOperationsDb db, int requestId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var request = await GetRequestRowAsync(connection, requestId, ct) ?? throw new NexusNotFoundException("Request not found.");
        var deliveries = await ListDeliveriesAsync(connection, requestId, ct);
        return new StagingRequestDetail(request, deliveries);
    }

    private static async Task<StagingRequestRow?> GetRequestRowAsync(SqlConnection connection, int requestId, CancellationToken ct) =>
        await connection.QuerySingleOrDefaultAsync<StagingRequestRow>(new CommandDefinition(
            $"SELECT {RequestColumns} FROM log.StagingRequest WHERE RequestId = @requestId", new { requestId }, cancellationToken: ct));

    private static async Task<IReadOnlyList<StagingRequestDeliveryRow>> ListDeliveriesAsync(SqlConnection connection, int requestId, CancellationToken ct)
    {
        var rows = await connection.QueryAsync<StagingRequestDeliveryRow>(new CommandDefinition("""
            SELECT DeliveryId, RequestId, QuantityMoved, Batch,
                   SourceStorageType, SourceBin, DestinationStorageType, DestinationBin,
                   TransferOrderNumber, DeliveredBy, DeliveredAtUtc
            FROM log.StagingRequestDelivery WHERE RequestId = @requestId ORDER BY DeliveredAtUtc ASC
            """, new { requestId }, cancellationToken: ct));
        return rows.AsList();
    }

    // ── Requests — writes ────────────────────────────────────────────────

    internal static async Task<CreateStagingRequestResult> CreateAsync(
        INexusOperationsDb db, ISapServerClient sap, IAuditLogger audit, INotificationService notify,
        CreateStagingRequestRequest body, string? requestedBy, string? ipAddress, int userId, CancellationToken ct)
    {
        var nonSap = body.IsNonSap;
        decimal quantityRequested;

        if (nonSap)
        {
            if (string.IsNullOrWhiteSpace(body.MaterialText))
                throw new NexusValidationException("A description is required for a non-SAP material request.");
            if (!(body.QuantityRequested > 0))
                throw new NexusValidationException("quantityRequested must be greater than zero.");
            quantityRequested = body.QuantityRequested!.Value;
        }
        else
        {
            if (string.IsNullOrWhiteSpace(body.Material))
                throw new NexusValidationException("material is required.");

            if (!string.IsNullOrWhiteSpace(body.RequestUnit))
            {
                if (!(body.RequestUnitQty > 0))
                    throw new NexusValidationException("requestUnitQty must be greater than zero.");
                decimal conversionQty;
                try
                {
                    conversionQty = await MaterialRequestUnitsHelper.GetConversionQtyAsync(db, body.Material, body.RequestUnit, ct);
                }
                catch (InvalidOperationException ex)
                {
                    throw new NexusValidationException(ex.Message);
                }
                quantityRequested = body.RequestUnitQty!.Value * conversionQty;
            }
            else if (!(body.QuantityRequested > 0))
            {
                throw new NexusValidationException("quantityRequested must be greater than zero.");
            }
            else
            {
                quantityRequested = body.QuantityRequested!.Value;
            }
        }

        if (string.IsNullOrWhiteSpace(body.Location))
            throw new NexusValidationException("location is required.");
        if (body.DueAtUtc is null)
            throw new NexusValidationException("dueAtUtc (Needed By) is required.");

        // Snap first, then check lead time against the *snapped* value — a
        // raw out-of-hours pick (e.g. 8pm) must not sail through the
        // lead-time check on its own distance from "now"; only the actual
        // usable Stores instant it resolves to counts.
        var due = StoresWorkingHoursHelper.SnapToStoresWindow(body.DueAtUtc.Value);
        var minDue = StoresWorkingHoursHelper.AddStoresLeadTime(DateTime.Now, StoresWorkingHoursHelper.NeededByMinLeadHours)
            .AddMinutes(-StoresWorkingHoursHelper.NeededByGraceMinutes);
        if (due < minDue)
        {
            throw new NexusValidationException(
                $"Needed By must allow at least {StoresWorkingHoursHelper.NeededByMinLeadHours} working hours' notice — Stores works 05:45–17:00, Monday–Friday. The earliest available time is {StoresWorkingHoursHelper.FormatStoresTime(minDue)}.");
        }

        using var connection = await db.CreateConnectionAsync(ct);
        var requestId = await connection.QuerySingleAsync<int>(new CommandDefinition("""
            INSERT INTO log.StagingRequest
                (Material, MaterialText, Uom, QuantityRequested, RequestUnit, RequestUnitQty, IsNonSap, Location, RequestedBatch, DueAtUtc, Notes, RequestedBy)
            OUTPUT INSERTED.RequestId
            VALUES (@material, @materialText, @uom, @quantityRequested, @requestUnit, @requestUnitQty, @isNonSap, @location, @requestedBatch, @due, @notes, @requestedBy)
            """, new
        {
            material = nonSap ? null : body.Material,
            materialText = body.MaterialText,
            uom = nonSap ? null : body.Uom,
            quantityRequested,
            requestUnit = nonSap ? null : body.RequestUnit,
            requestUnitQty = nonSap ? null : (body.RequestUnit is not null ? body.RequestUnitQty : null),
            isNonSap = nonSap,
            location = body.Location,
            requestedBatch = nonSap ? null : body.RequestedBatch,
            due,
            notes = body.Notes,
            requestedBy,
        }, cancellationToken: ct));

        await audit.LogAsync("STAGING_REQUEST_CREATED", requestedBy,
            $"Request #{requestId} — {quantityRequested} of {(nonSap ? body.MaterialText : body.Material)} to {body.Location}", ipAddress, ct);

        // Let the warehouse department know a new request is waiting —
        // best-effort, must never block the response the requester is
        // waiting on.
        try
        {
            await notify.NotifyAsync(new NotificationRequest(
                Title: "New Staging Post Request",
                Body: $"{requestedBy} requested {quantityRequested}{(string.IsNullOrEmpty(body.Uom) ? "" : $" {body.Uom}")} of {(nonSap ? body.MaterialText : body.Material)} to {body.Location}, needed by {StoresWorkingHoursHelper.FormatStoresTime(due)}.",
                Severity: 1, Category: "logistics",
                ActionLabel: "Open Staging Post", ActionUrl: "/private/warehouse.html",
                Target: new NotificationTarget(NotificationTargetType.Department, "warehouse")), ct);
        }
        catch { /* best-effort, must never block the response */ }

        // Live stock check (SAP materials only) — never blocks the request,
        // only makes a shortfall visible up front rather than Stores
        // discovering it cold.
        StagingStockWarning? stockWarning = null;
        if (!nonSap)
        {
            try
            {
                var stockRows = await FetchLquaStockAsync(sap, userId, new SapStockQuery(Material: body.Material, StorageType: "RO"), ct);
                var availableQty = stockRows.Sum(r => r.AvailableQty);
                if (availableQty < quantityRequested)
                {
                    stockWarning = new StagingStockWarning(availableQty, quantityRequested);
                    var detail = $"Request #{requestId} — {requestedBy} asked for {quantityRequested}{(string.IsNullOrEmpty(body.Uom) ? "" : $" {body.Uom}")} of {body.Material} to {body.Location}, but only {availableQty} is available in Storage Type RO.";
                    await audit.LogAsync("STAGING_REQUEST_LOW_STOCK", requestedBy, detail, ipAddress, ct);

                    // Each target notified independently — a failure fanning
                    // out to one permission code must never stop the other.
                    foreach (var permissionCode in new[] { "PROD_SUPERVISOR", "LOG_SUPER" })
                    {
                        try
                        {
                            await notify.NotifyAsync(new NotificationRequest(
                                Title: "Staging Post Request — Insufficient Stock",
                                Body: detail, Severity: 2, Category: "logistics",
                                ActionLabel: "Open Staging Post", ActionUrl: "/private/warehouse.html",
                                Target: new NotificationTarget(NotificationTargetType.Permission, permissionCode)), ct);
                        }
                        catch { /* best-effort per target */ }
                    }
                }
            }
            catch
            {
                // LQUA being unreachable must never block the request itself
                // — Stores' own stock lookup is the authoritative check when
                // they actually come to fulfil it.
            }
        }

        return new CreateStagingRequestResult(requestId, due, stockWarning);
    }

    internal static async Task CancelAsync(INexusOperationsDb db, IAuditLogger audit, int requestId, string? actor, string? ipAddress, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var cancelledId = await connection.QuerySingleOrDefaultAsync<int?>(new CommandDefinition("""
            UPDATE log.StagingRequest
                SET Status = 'Cancelled', CancelledBy = @actor, CancelledAtUtc = GETUTCDATE(), UpdatedAtUtc = GETUTCDATE()
            OUTPUT INSERTED.RequestId
            WHERE RequestId = @requestId AND Status = 'Open' AND QuantityDelivered = 0
            """, new { requestId, actor }, cancellationToken: ct));

        if (cancelledId is null)
            throw new NexusValidationException("This request can no longer be cancelled — it may already have a delivery against it, or already be closed.");

        await audit.LogAsync("STAGING_REQUEST_CANCELLED", actor, $"Request #{requestId}", ipAddress, ct);
    }

    internal static async Task CompleteAsync(INexusOperationsDb db, IAuditLogger audit, int requestId, string? actor, string? ipAddress, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var completedId = await connection.QuerySingleOrDefaultAsync<int?>(new CommandDefinition("""
            UPDATE log.StagingRequest
                SET Status = 'Completed', CompletedBy = @actor, CompletedAtUtc = GETUTCDATE(), UpdatedAtUtc = GETUTCDATE()
            OUTPUT INSERTED.RequestId
            WHERE RequestId = @requestId AND Status = 'Open'
            """, new { requestId, actor }, cancellationToken: ct));

        if (completedId is null)
            throw new NexusValidationException("This request is no longer open.");

        await audit.LogAsync("STAGING_REQUEST_COMPLETED", actor, $"Request #{requestId}", ipAddress, ct);
    }

    // ── Stock lookups ────────────────────────────────────────────────────

    internal static async Task<IReadOnlyList<SapStockRow>> GetStockAsync(ISapServerClient sap, int userId, string? material, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(material))
            throw new NexusValidationException("material is required.");
        return await FetchLquaStockAsync(sap, userId, new SapStockQuery(Material: material), ct);
    }

    /// <summary>Whole-material stock, not just the allowed bins — restricted bins are flagged (IsAllowed), not filtered out, so Stores can still see stock that exists in a non-permitted bin rather than wrongly concluding there's none at all.</summary>
    internal static async Task<RequestStockResult> GetRequestStockAsync(INexusOperationsDb db, ISapServerClient sap, int userId, int requestId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var request = await GetRequestRowAsync(connection, requestId, ct) ?? throw new NexusNotFoundException("Request not found.");

        if (request.IsNonSap)
            return new RequestStockResult([], false, null);

        var requestedBatch = string.IsNullOrWhiteSpace(request.RequestedBatch) ? null : request.RequestedBatch;

        var stockTask = FetchLquaStockAsync(sap, userId, new SapStockQuery(Material: request.Material, Batch: requestedBatch), ct);
        var restrictionsTask = connection.QueryAsync<StagingBinRestrictionForMaterialRow>(new CommandDefinition("""
            SELECT RestrictionId, Material, StorageType, Bin, Notes
            FROM log.StagingBinRestriction WHERE Material = @material ORDER BY StorageType, Bin
            """, new { material = request.Material }, cancellationToken: ct));

        await Task.WhenAll(stockTask, restrictionsTask);
        var stockRows = await stockTask;
        var restrictions = (await restrictionsTask).ToList();

        bool IsAllowed(SapStockRow row) =>
            restrictions.Count == 0 || restrictions.Any(r => r.StorageType == row.StorageType && (r.Bin is null || r.Bin == row.Bin));

        var data = stockRows.Select(r => new StagingStockRow(
            r.StorageLocation, r.StorageType, r.Bin, r.Material, r.AvailableQty, r.Batch,
            r.StockCategory, r.SpecialStockInd, r.SpecialStockNum, r.GrDate, r.ProfitCentre, IsAllowed(r))).ToList();

        return new RequestStockResult(data, restrictions.Count > 0, requestedBatch);
    }

    // ── Mark Delivered ───────────────────────────────────────────────────
    //
    // Creates the real SAP transfer order first (existing endpoint) — only
    // records the delivery against the request if SAP actually accepted it,
    // so the audit trail never shows a delivery that didn't really happen.

    internal static async Task<DeliverStagingRequestResult> DeliverAsync(
        INexusOperationsDb db, ISapServerClient sap, IAuditLogger audit,
        int requestId, DeliverStagingRequestRequest body, string? actor, string? ipAddress, int userId, CancellationToken ct)
    {
        using var readConnection = await db.CreateConnectionAsync(ct);
        var request = await GetRequestRowAsync(readConnection, requestId, ct) ?? throw new NexusNotFoundException("Request not found.");
        if (request.Status != "Open")
            throw new NexusValidationException("This request is no longer open.");
        if (!(body.Quantity > 0))
            throw new NexusValidationException("quantity must be greater than zero.");

        // Non-SAP requests have nowhere in SAP to move stock from/to at all,
        // so none of the bin/location fields below apply — Stores just
        // confirms the physical hand-off happened.
        if (!request.IsNonSap && (string.IsNullOrWhiteSpace(body.StorageLocation) || string.IsNullOrWhiteSpace(body.SourceStorageType) || string.IsNullOrWhiteSpace(body.SourceBin) || string.IsNullOrWhiteSpace(body.DestinationStorageType) || string.IsNullOrWhiteSpace(body.DestinationBin)))
            throw new NexusValidationException("Storage location, source bin/type and destination bin/type are all required.");

        // Consignment stock (LQUA-SOBKZ = 'K') moving into a production bin
        // needs the MB1B + LT01 pair, not a plain transfer order.
        var isConsignment = !request.IsNonSap && body.SpecialStockIndicator == "K" && body.DestinationStorageType == "SA";
        if (isConsignment && string.IsNullOrWhiteSpace(body.SpecialStockNumber))
            throw new NexusValidationException("This stock is held as consignment stock (SOBKZ K) — a special stock number (vendor) is required to issue it.");

        string? transferOrderNumber = null;
        var messages = new List<SapReturnMessage>();
        var sapSuccess = true;

        if (!request.IsNonSap)
        {
            try
            {
                if (isConsignment)
                {
                    var mb1b = await sap.PostAsync<ConsignmentMb1bResponse>("api/warehouse/consignment-mb1b", new ConsignmentMb1bRequest(
                        Material: request.Material!, Quantity: body.Quantity, Header: $"Staging Post fulfilment — Request #{requestId}",
                        SpecialStockNumber: body.SpecialStockNumber!, StorageLocation: body.StorageLocation!,
                        SourceType: body.SourceStorageType!, SourceBin: body.SourceBin!,
                        DestinationType: body.DestinationStorageType!, DestinationBin: body.DestinationBin!), userId, longRunning: true, ct: ct)
                        ?? throw new InvalidOperationException("SAP server error");

                    sapSuccess = mb1b.Success;
                    // mb1b.Success reflects whether SAP actually accepted all
                    // three legs (MB1B goods issue + both LT01 transfer
                    // postings), not just that the RFC calls didn't throw.
                    foreach (var msg in new[] { mb1b.Mb1bMessage, mb1b.ToNonConsignMessage, mb1b.ToConsignMessage })
                    {
                        if (!string.IsNullOrEmpty(msg))
                            messages.Add(new SapReturnMessage(msg.StartsWith("E ") ? "E" : "S", msg));
                    }
                }
                else
                {
                    var to = await CreateSapTransferOrderAsync(db, sap, userId, new CreateTransferOrderRequest(
                        StorageLocation: body.StorageLocation!, Material: request.Material!, Quantity: body.Quantity,
                        SourceType: body.SourceStorageType!, SourceBin: body.SourceBin!,
                        DestinationType: body.DestinationStorageType!, DestinationBin: body.DestinationBin!,
                        Batch: body.Batch ?? request.RequestedBatch, StockCategory: body.StockCategory,
                        SpecialStockIndicator: body.SpecialStockIndicator, SpecialStockNumber: body.SpecialStockNumber), ct);

                    sapSuccess = to.Success;
                    transferOrderNumber = string.IsNullOrEmpty(to.TransferOrderNumber) ? null : to.TransferOrderNumber;
                    messages = to.Messages;
                }
            }
            catch (Exception ex) when (ex is not NexusApiException)
            {
                await audit.LogAsync("STAGING_DELIVER_SAP_ERROR", actor, $"Request #{requestId} — {ex.Message}", ipAddress, ct);
                throw new NexusUnprocessableEntityException($"SAP rejected the {(isConsignment ? "consignment issue" : "transfer order")}: {ex.Message}");
            }

            if (!sapSuccess)
            {
                var joined = string.Join("; ", messages.Select(m => m.Message).Where(m => !string.IsNullOrEmpty(m)));
                return new DeliverStagingRequestResult("REJECTED", joined.Length > 0 ? joined : "SAP rejected the transfer order.", null, messages, null, null, null, null, null);
            }
        }

        using var connection = await db.CreateConnectionAsync(ct);

        await connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO log.StagingRequestDelivery
                (RequestId, QuantityMoved, Batch, SourceStorageType, SourceBin, DestinationStorageType, DestinationBin, TransferOrderNumber, DeliveredBy)
            VALUES (@requestId, @quantityMoved, @batch, @sourceStorageType, @sourceBin, @destinationStorageType, @destinationBin, @transferOrderNumber, @deliveredBy)
            """, new
        {
            requestId,
            quantityMoved = body.Quantity,
            batch = request.IsNonSap ? null : (body.Batch ?? request.RequestedBatch),
            sourceStorageType = request.IsNonSap ? null : body.SourceStorageType,
            sourceBin = request.IsNonSap ? null : body.SourceBin,
            destinationStorageType = request.IsNonSap ? null : body.DestinationStorageType,
            destinationBin = request.IsNonSap ? null : body.DestinationBin,
            transferOrderNumber,
            deliveredBy = actor,
        }, cancellationToken: ct));

        var updated = await connection.QuerySingleAsync<(decimal QuantityDelivered, decimal QuantityRequested)>(new CommandDefinition("""
            UPDATE log.StagingRequest
                SET QuantityDelivered = QuantityDelivered + @quantityMoved, UpdatedAtUtc = GETUTCDATE()
            OUTPUT INSERTED.QuantityDelivered, INSERTED.QuantityRequested
            WHERE RequestId = @requestId
            """, new { requestId, quantityMoved = body.Quantity }, cancellationToken: ct));

        var delivered = updated.QuantityDelivered;
        var requested = updated.QuantityRequested;
        var metOrExceeded = delivered >= requested;
        var shortfallPct = requested > 0 ? (requested - delivered) / requested : 0m;
        var withinTolerance = !metOrExceeded && shortfallPct > 0 && shortfallPct <= WithinTolerancePct;

        await audit.LogAsync("STAGING_DELIVERED", actor,
            $"Request #{requestId} — {body.Quantity} moved{(transferOrderNumber is not null ? $", TO {transferOrderNumber}" : (request.IsNonSap ? " (non-SAP, no SAP movement)" : ""))}", ipAddress, ct);

        var redrum = request.IsNonSap
            ? null
            : await RedrumReversalHelper.MaybeReverseBatchManagedReturnAsync(
                connection, sap, audit, body.Batch ?? request.RequestedBatch,
                body.DestinationStorageType!, body.DestinationBin!, body.StorageLocation,
                actor, ipAddress, userId, ct);

        var redrumDto = redrum is null ? null : new RedrumReversalResult(redrum.Status, redrum.MaterialDocument, redrum.ReversalDocument, redrum.TransferOrderNumber, redrum.DrummingId, redrum.Warning, redrum.Error);

        return new DeliverStagingRequestResult("OK", null, transferOrderNumber, messages, delivered, requested, metOrExceeded, withinTolerance, redrumDto);
    }

    // ── KPIs (Completed requests only) ──────────────────────────────────

    internal static async Task<StagingKpiResult> ComputeKpisAsync(INexusOperationsDb db, DateTime? from, DateTime? to, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var (whereSql, parameters) = BuildDateRangeWhere("Status = 'Completed'", "RequestedAtUtc", from, to);

        var overall = await connection.QuerySingleAsync<StagingKpiOverall>(new CommandDefinition($"""
            SELECT
                COUNT(*) AS CompletedCount,
                ISNULL(SUM(CASE WHEN CompletedAtUtc <= DueAtUtc THEN 1 ELSE 0 END), 0) AS OnTimeCount,
                AVG(CAST(DATEDIFF(MINUTE, RequestedAtUtc, CompletedAtUtc) AS DECIMAL(15,2))) / 60.0 AS AvgLeadTimeHours
            FROM log.StagingRequest WHERE {whereSql}
            """, parameters, cancellationToken: ct));

        var byMaterial = await connection.QueryAsync<StagingKpiByMaterial>(new CommandDefinition($"""
            SELECT Material, MAX(MaterialText) AS MaterialText, COUNT(*) AS CompletedCount,
                   ISNULL(SUM(CASE WHEN CompletedAtUtc <= DueAtUtc THEN 1 ELSE 0 END), 0) AS OnTimeCount,
                   AVG(CAST(DATEDIFF(MINUTE, RequestedAtUtc, CompletedAtUtc) AS DECIMAL(15,2))) / 60.0 AS AvgLeadTimeHours
            FROM log.StagingRequest WHERE {whereSql}
            GROUP BY Material ORDER BY Material
            """, parameters, cancellationToken: ct));

        return new StagingKpiResult(overall, byMaterial.AsList());
    }

    // ── Bin restrictions (Warehouse Supervisor config, LOG_SUPER-gated writes) ──

    internal static async Task<IReadOnlyList<StagingBinRestrictionRow>> ListBinRestrictionsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<StagingBinRestrictionRow>(new CommandDefinition("""
            SELECT RestrictionId, Material, StorageType, Bin, Notes, CreatedBy, CreatedAtUtc
            FROM log.StagingBinRestriction ORDER BY Material, StorageType, Bin
            """, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<int> CreateBinRestrictionAsync(INexusOperationsDb db, CreateBinRestrictionRequest body, string? actor, CancellationToken ct)
    {
        ValidateBinRestriction(body);
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleAsync<int>(new CommandDefinition("""
            INSERT INTO log.StagingBinRestriction (Material, StorageType, Bin, Notes, CreatedBy)
            OUTPUT INSERTED.RestrictionId
            VALUES (@material, @storageType, @bin, @notes, @createdBy)
            """, new { material = body.Material, storageType = body.StorageType, bin = body.Bin, notes = body.Notes, createdBy = actor }, cancellationToken: ct));
    }

    internal static async Task UpdateBinRestrictionAsync(INexusOperationsDb db, int restrictionId, CreateBinRestrictionRequest body, CancellationToken ct)
    {
        ValidateBinRestriction(body);
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.StagingBinRestriction SET Material = @material, StorageType = @storageType, Bin = @bin, Notes = @notes
            WHERE RestrictionId = @restrictionId
            """, new { restrictionId, material = body.Material, storageType = body.StorageType, bin = body.Bin, notes = body.Notes }, cancellationToken: ct));
    }

    internal static async Task DeleteBinRestrictionAsync(INexusOperationsDb db, int restrictionId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "DELETE FROM log.StagingBinRestriction WHERE RestrictionId = @restrictionId", new { restrictionId }, cancellationToken: ct));
    }

    /// <summary>Records that already have an identical Material+StorageType+Bin restriction are skipped (NOT EXISTS) rather than inserted as a duplicate, so a re-uploaded/overlapping CSV is safe to import again.</summary>
    internal static async Task<BulkImportBinRestrictionsResult> BulkImportBinRestrictionsAsync(INexusOperationsDb db, List<BinRestrictionImportRow> records, string? actor, CancellationToken ct)
    {
        if (records.Count == 0)
            throw new NexusValidationException("records array is required and must not be empty");

        using var connection = await db.CreateConnectionAsync(ct);
        int inserted = 0, skipped = 0;
        var errors = new List<BinRestrictionImportError>();

        foreach (var r in records)
        {
            try
            {
                var rows = await connection.ExecuteAsync(new CommandDefinition("""
                    INSERT INTO log.StagingBinRestriction (Material, StorageType, Bin, Notes, CreatedBy)
                    SELECT @material, @storageType, @bin, @notes, @createdBy
                    WHERE NOT EXISTS (
                        SELECT 1 FROM log.StagingBinRestriction
                        WHERE Material = @material AND StorageType = @storageType AND ISNULL(Bin, '') = ISNULL(@bin, '')
                    )
                    """, new { material = r.Material, storageType = r.StorageType, bin = r.Bin, notes = r.Notes, createdBy = actor }, cancellationToken: ct));
                if (rows > 0) inserted++; else skipped++;
            }
            catch (Exception ex)
            {
                errors.Add(new BinRestrictionImportError(r.Material, ex.Message));
            }
        }

        return new BulkImportBinRestrictionsResult(inserted, skipped, errors);
    }

    private static void ValidateBinRestriction(CreateBinRestrictionRequest body)
    {
        if (string.IsNullOrWhiteSpace(body.Material))
            throw new NexusValidationException("material is required.");
        if (string.IsNullOrWhiteSpace(body.StorageType))
            throw new NexusValidationException("storageType is required.");
    }

    // ── SAP callers ──────────────────────────────────────────────────────

    /// <summary>Guarded by the stock-count transfer block — StockCountGuardHelper.AssertTransfersAllowedAsync — since this is the one place in this Helper that actually moves stock via a plain transfer order (the consignment MB1B path below is not guarded, matching Node's own asymmetry exactly).</summary>
    private static async Task<CreateTransferOrderResponse> CreateSapTransferOrderAsync(INexusOperationsDb db, ISapServerClient sap, int userId, CreateTransferOrderRequest body, CancellationToken ct)
    {
        try
        {
            await StockCountGuardHelper.AssertTransfersAllowedAsync(db, body.StorageLocation, ct);
        }
        catch (TransferBlockedException ex)
        {
            throw new InvalidOperationException(ex.Message);
        }

        return await sap.PostAsync<CreateTransferOrderResponse>("api/warehouse/transfer-order", body, userId, longRunning: true, ct: ct)
            ?? throw new InvalidOperationException("SAP server error");
    }

    /// <summary>Queries SapServer's existing GET /api/warehouse/stock (LQUA), already filterable by material/storage type/bin/batch — sent as a real query string since that endpoint model-binds [FromUri], not a JSON body.</summary>
    private static async Task<List<SapStockRow>> FetchLquaStockAsync(ISapServerClient sap, int userId, SapStockQuery query, CancellationToken ct)
    {
        var qs = new Dictionary<string, string?>();
        if (query.Material is not null) qs["material"] = query.Material;
        if (query.StorageType is not null) qs["storageType"] = query.StorageType;
        if (query.ExcludeStorageType is not null) qs["excludeStorageType"] = query.ExcludeStorageType;
        if (query.Bin is not null) qs["bin"] = query.Bin;
        if (query.Batch is not null) qs["batch"] = query.Batch;
        if (query.StorageLocation is not null) qs["storageLocation"] = query.StorageLocation;
        if (query.StockCategory is not null) qs["stockCategory"] = query.StockCategory;
        if (query.ProfitCentre is not null) qs["profitCentre"] = query.ProfitCentre;
        qs["rowCount"] = query.RowCount.ToString();

        var path = QueryHelpers.AddQueryString("api/warehouse/stock", qs);
        return await sap.GetAsync<List<SapStockRow>>(path, userId, ct: ct) ?? [];
    }

    // ── Shared SQL builders ──────────────────────────────────────────────

    private const string RequestColumns = """
        RequestId, Material, MaterialText, Uom, QuantityRequested, QuantityDelivered,
        RequestUnit, RequestUnitQty, IsNonSap,
        Location, RequestedBatch, DueAtUtc, Notes, Status,
        RequestedBy, RequestedAtUtc, CompletedBy, CompletedAtUtc,
        CancelledBy, CancelledAtUtc, UpdatedAtUtc
        """;

    private static (string WhereSql, DynamicParameters Parameters) BuildDateRangeWhere(string baseClause, string dateColumn, DateTime? from, DateTime? to)
    {
        var where = new List<string> { baseClause };
        var parameters = new DynamicParameters();
        if (from is not null) { where.Add($"{dateColumn} >= @from"); parameters.Add("from", from); }
        if (to is not null) { where.Add($"{dateColumn} < @to"); parameters.Add("to", to); }
        return (string.Join(" AND ", where), parameters);
    }
}
