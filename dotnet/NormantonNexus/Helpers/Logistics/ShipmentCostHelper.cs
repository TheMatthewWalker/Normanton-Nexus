using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Freight cost lines (log.ShipmentCost) — Logistics Sub-phase 8a.5a. Port
/// of the CRUD/read subset of routes/shipmentcost.js: GET all/by-id/by-
/// shipment/by-costtype, PATCH/DELETE an unprocessed line, POST (outbound)
/// create, POST/PATCH manual (unlinked) cost lines, GET estimate, GET
/// unprocessed/processed.
///
/// Deliberately excludes, flagged for a dedicated follow-up rather than
/// rushed here: POST /post-migo and POST /:costId/reverse — real SAP
/// purchase-order/goods-receipt creation under the calling user's own
/// credentials, the single highest-business-risk endpoint in this whole
/// migration per the plan's own Phase 8 sub-phase breakdown — and GET
/// /analytics, which (like /unprocessed and /processed here) needs the
/// not-yet-ported inbound log.PurchaseOrderShipment leg to be complete.
///
/// The unprocessed/processed cost list is a real, if partial, port: it
/// includes outbound (shipmentID set) and manual (both FKs NULL) rows.
/// Node's own query is a 3-way UNION ALL that also includes an inbound leg
/// (poShipmentID set, joined against log.PurchaseOrderShipment) — that
/// table isn't ported anywhere in this app yet (same gap
/// ShipmentHelper.SearchAsync's own inbound leg and the otif-report route
/// already deferred to Sub-phase 8b), so this port's WHERE clause
/// implicitly restricts to `sc.poShipmentID IS NULL`, i.e. every inbound
/// row is silently absent from these lists until 8b lands and the leg can
/// be added back in.
/// </summary>
internal static class ShipmentCostHelper
{
    internal static async Task<IReadOnlyList<ShipmentCostRow>> GetAllAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ShipmentCostRow>(new CommandDefinition(SelectAllColumns + "FROM log.ShipmentCost", cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<IReadOnlyList<ShipmentCostRow>> GetByIdAsync(INexusOperationsDb db, long costId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ShipmentCostRow>(new CommandDefinition(
            SelectAllColumns + "FROM log.ShipmentCost WHERE costID = @costId", new { costId }, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<IReadOnlyList<ShipmentCostRow>> GetByCostTypeAsync(INexusOperationsDb db, string costType, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ShipmentCostRow>(new CommandDefinition(
            SelectAllColumns + "FROM log.ShipmentCost WHERE costType = @costType", new { costType }, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<IReadOnlyList<ShipmentCostByShipmentRow>> GetByShipmentAsync(INexusOperationsDb db, long shipmentId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ShipmentCostByShipmentRow>(new CommandDefinition("""
            SELECT sc.costID AS CostId, sc.shipmentID AS ShipmentId, sc.costType AS CostType, sc.costElement AS CostElement, sc.costCenter AS CostCenter,
                sc.expectedCost AS ExpectedCost, sc.actualCost AS ActualCost, sc.migoStatus AS MigoStatus, sc.materialDocument AS MaterialDocument, sc.modeOfTransport AS ModeOfTransport,
                ce.elementDescription AS ElementDescription, ce.tier AS Tier
            FROM log.ShipmentCost sc
            LEFT JOIN log.CostElements ce ON ce.elementCode = sc.costElement AND ce.direction = 'outbound'
            WHERE sc.shipmentID = @shipmentId
            ORDER BY sc.costID DESC
            """, new { shipmentId }, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task UpdateAsync(INexusOperationsDb db, long costId, UpdateShipmentCostRequest body, CancellationToken ct)
    {
        if (body.ExpectedCost <= 0)
            throw new NexusValidationException("expectedCost must be a positive number.");
        if (body.CostElement is not null && body.CostElement.Trim().Length == 0)
            throw new NexusValidationException("costElement cannot be blank.");
        if (body.CostCenter is not null && body.CostCenter.Trim().Length == 0)
            throw new NexusValidationException("costCenter cannot be blank.");
        if (body.CostType is not null && body.CostType.Trim().Length == 0)
            throw new NexusValidationException("costType cannot be blank.");

        var sets = new List<string> { "expectedCost = @expectedCost" };
        var parameters = new DynamicParameters();
        parameters.Add("costId", costId);
        parameters.Add("expectedCost", body.ExpectedCost);
        if (body.CostElement is not null) { sets.Add("costElement = @costElement"); parameters.Add("costElement", body.CostElement.Trim()); }
        if (body.CostCenter is not null) { sets.Add("costCenter = @costCenter"); parameters.Add("costCenter", body.CostCenter.Trim()); }
        if (body.CostType is not null) { sets.Add("costType = @costType"); parameters.Add("costType", body.CostType.Trim()); }

        using var connection = await db.CreateConnectionAsync(ct);
        var updatedId = await connection.QuerySingleOrDefaultAsync<long?>(new CommandDefinition($"""
            UPDATE log.ShipmentCost SET {string.Join(", ", sets)}
            OUTPUT INSERTED.costID
            WHERE costID = @costId AND ISNULL(migoStatus, 0) = 0
            """, parameters, cancellationToken: ct));

        if (updatedId is null)
            throw new NexusValidationException("Line not found, or already posted to SAP.");
    }

    internal static async Task DeleteAsync(INexusOperationsDb db, long costId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var deletedId = await connection.QuerySingleOrDefaultAsync<long?>(new CommandDefinition("""
            DELETE FROM log.ShipmentCost
            OUTPUT DELETED.costID
            WHERE costID = @costId AND ISNULL(migoStatus, 0) = 0
            """, new { costId }, cancellationToken: ct));

        if (deletedId is null)
            throw new NexusValidationException("Line not found, or already posted to SAP.");
    }

    internal static async Task<CreateShipmentCostResult> CreateAsync(INexusOperationsDb db, CreateShipmentCostRequest body, CancellationToken ct)
    {
        if (body.ShipmentId is null && body.PoShipmentId is null)
            throw new NexusValidationException("shipmentID or poShipmentID is required.");
        if (string.IsNullOrWhiteSpace(body.CostElement))
            throw new NexusValidationException("costElement is required.");
        if (string.IsNullOrWhiteSpace(body.CostCenter))
            throw new NexusValidationException("costCenter is required.");
        if (string.IsNullOrWhiteSpace(body.CostType))
            throw new NexusValidationException("costType is required.");
        if (body.ExpectedCost <= 0)
            throw new NexusValidationException("expectedCost must be a positive number.");

        using var connection = await db.CreateConnectionAsync(ct);
        var costId = await connection.QuerySingleAsync<long>(new CommandDefinition("""
            INSERT INTO log.ShipmentCost
                (shipmentID, poShipmentID, costType, costElement, costCenter,
                 expectedCost, actualCost, migoStatus, materialDocument, modeOfTransport)
            OUTPUT INSERTED.costID
            VALUES (@shipmentId, @poShipmentId, @costType, @costElement, @costCenter,
                 @expectedCost, @actualCost, @migoStatus, @materialDocument, @modeOfTransport)
            """, new
        {
            shipmentId = body.ShipmentId, poShipmentId = body.PoShipmentId, costType = body.CostType, costElement = body.CostElement, costCenter = body.CostCenter,
            expectedCost = body.ExpectedCost, actualCost = body.ActualCost, migoStatus = body.MigoStatus ?? false, materialDocument = body.MaterialDocument, modeOfTransport = body.ModeOfTransport,
        }, cancellationToken: ct));

        return new CreateShipmentCostResult(costId);
    }

    internal static async Task<ManualShipmentCostResult> CreateManualAsync(INexusOperationsDb db, ManualShipmentCostRequest body, CancellationToken ct)
    {
        ValidateManual(body);
        using var connection = await db.CreateConnectionAsync(ct);
        var costElement = await ResolveCostElementAsync(connection, body, ct);

        var costId = await connection.QuerySingleAsync<long>(new CommandDefinition("""
            INSERT INTO log.ShipmentCost
                (shipmentID, poShipmentID, costType, costElement, costCenter,
                 expectedCost, actualCost, migoStatus, modeOfTransport,
                 manualReference, manualForwarderID, manualCountry, manualPostcode,
                 manualTrackingNumber, manualIncurredDate)
            OUTPUT INSERTED.costID
            VALUES (NULL, NULL, @costType, @costElement, @costCenter,
                 @expectedCost, @expectedCost, 0, @modeOfTransport,
                 @manualReference, @manualForwarderId, @manualCountry, @manualPostcode,
                 @manualTrackingNumber, @manualIncurredDate)
            """, ManualParameters(body, costElement), cancellationToken: ct));

        return new ManualShipmentCostResult(costId, costElement);
    }

    internal static async Task<ManualShipmentCostResult> UpdateManualAsync(INexusOperationsDb db, long costId, ManualShipmentCostRequest body, CancellationToken ct)
    {
        ValidateManual(body);
        using var connection = await db.CreateConnectionAsync(ct);
        var costElement = await ResolveCostElementAsync(connection, body, ct);

        var parameters = ManualParameters(body, costElement);
        parameters.Add("costId", costId);
        var updatedId = await connection.QuerySingleOrDefaultAsync<long?>(new CommandDefinition("""
            UPDATE log.ShipmentCost
            SET costType = @costType, costElement = @costElement, costCenter = @costCenter,
                expectedCost = @expectedCost, actualCost = @expectedCost, modeOfTransport = @modeOfTransport,
                manualReference = @manualReference, manualForwarderID = @manualForwarderId,
                manualCountry = @manualCountry, manualPostcode = @manualPostcode,
                manualTrackingNumber = @manualTrackingNumber, manualIncurredDate = @manualIncurredDate
            OUTPUT INSERTED.costID
            WHERE costID = @costId AND shipmentID IS NULL AND poShipmentID IS NULL AND ISNULL(migoStatus, 0) = 0
            """, parameters, cancellationToken: ct));

        if (updatedId is null)
            throw new NexusValidationException("Line not found, not a manual cost line, or already posted to SAP.");

        return new ManualShipmentCostResult(costId, costElement);
    }

    private static void ValidateManual(ManualShipmentCostRequest body)
    {
        if (body.Direction != "inbound" && body.Direction != "outbound")
            throw new NexusValidationException("direction must be 'inbound' or 'outbound'.");
        if (body.Tier != "standard" && body.Tier != "premium")
            throw new NexusValidationException("tier must be 'standard' or 'premium'.");
        if (body.ExpectedCost <= 0)
            throw new NexusValidationException("expectedCost must be a positive number.");
        if (string.IsNullOrWhiteSpace(body.CostCenter))
            throw new NexusValidationException("costCenter is required.");
        if (body.ForwarderId <= 0)
            throw new NexusValidationException("forwarderID (haulier) is required.");
        if (string.IsNullOrWhiteSpace(body.ModeOfTransport))
            throw new NexusValidationException("modeOfTransport is required.");
        if (string.IsNullOrWhiteSpace(body.Reference))
            throw new NexusValidationException("reference is required.");
        if (string.IsNullOrWhiteSpace(body.Country))
            throw new NexusValidationException("country is required.");
        if (string.IsNullOrWhiteSpace(body.Postcode))
            throw new NexusValidationException("postcode is required.");
        if (string.IsNullOrWhiteSpace(body.CostType))
            throw new NexusValidationException("costType is required.");
    }

    private static async Task<string> ResolveCostElementAsync(System.Data.IDbConnection connection, ManualShipmentCostRequest body, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(body.CostElement)) return body.CostElement.Trim();

        var costElement = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "SELECT TOP 1 elementCode FROM log.CostElements WHERE direction = @direction AND tier = @tier",
            new { direction = body.Direction, tier = body.Tier }, cancellationToken: ct));

        return costElement ?? throw new NexusUnprocessableEntityException($"No {body.Direction} {body.Tier} cost element configured in log.CostElements.");
    }

    private static DynamicParameters ManualParameters(ManualShipmentCostRequest body, string costElement)
    {
        var parameters = new DynamicParameters();
        parameters.Add("costType", body.CostType.Trim());
        parameters.Add("costElement", costElement);
        parameters.Add("costCenter", body.CostCenter);
        parameters.Add("expectedCost", body.ExpectedCost);
        parameters.Add("modeOfTransport", body.ModeOfTransport);
        parameters.Add("manualReference", body.Reference.Trim());
        parameters.Add("manualForwarderId", body.ForwarderId);
        parameters.Add("manualCountry", body.Country.Trim());
        parameters.Add("manualPostcode", body.Postcode.Trim());
        parameters.Add("manualTrackingNumber", string.IsNullOrWhiteSpace(body.TrackingNumber) ? null : body.TrackingNumber.Trim());
        parameters.Add("manualIncurredDate", body.IncurredDate);
        return parameters;
    }

    internal static async Task<CostEstimateResult> GetEstimateAsync(INexusOperationsDb db, long shipmentId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var shipment = await connection.QuerySingleOrDefaultAsync<EstimateShipmentRow>(new CommandDefinition("""
            SELECT sm.shipmentID AS ShipmentId, sm.grossWeight AS GrossWeight, sm.shipmentVolume AS ShipmentVolume,
                sm.destinationCountry AS DestinationCountry, sm.destinationPostCode AS DestinationPostCode,
                sm.originID AS OriginId, sm.destinationID AS DestinationId, sm.incoTerms AS IncoTerms,
                f.forwarderName AS ForwarderName, f.forwarderMode AS ForwarderMode
            FROM log.ShipmentMain sm
            LEFT JOIN log.Forwarders f ON f.forwarderID = sm.forwarderID
            WHERE sm.shipmentID = @shipmentId
            """, new { shipmentId }, cancellationToken: ct))
            ?? throw new NexusNotFoundException("Shipment not found");

        var forwarderNorm = System.Text.RegularExpressions.Regex.Replace((shipment.ForwarderName ?? "").ToLowerInvariant(), "[^a-z0-9]", "");
        var isKn = forwarderNorm.Contains("kuehnenagel") || forwarderNorm.Contains("kuehneandnagel");
        var isKh = forwarderNorm.Contains("howley") || forwarderNorm.Contains("kennethhowley");

        var direction = (shipment.OriginId is null || shipment.OriginId == 0) ? "outbound" : "inbound";
        var tier = (shipment.ForwarderMode ?? "").ToLowerInvariant().Contains("premium") ? "premium" : "standard";

        var elementCode = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "SELECT TOP 1 elementCode FROM log.CostElements WHERE direction = @direction AND tier = @tier",
            new { direction, tier }, cancellationToken: ct));

        var incoNorm = (shipment.IncoTerms ?? "").ToUpperInvariant().Replace(" ", "");
        decimal? customsCost = isKn ? (incoNorm == "DDP" ? 50m : 0m) : null;

        if (!isKn)
            return new CostEstimateResult(isKn, isKh, direction, tier, elementCode, null, null, null, null, null, null, null, customsCost, shipment.IncoTerms, null);

        var grossWeight = shipment.GrossWeight ?? 0m;
        var volumetricWeight = (shipment.ShipmentVolume ?? 0m) * 333m;
        var chargeableWeight = (int)Math.Ceiling(Math.Max(grossWeight, volumetricWeight));
        var postcodePrefix = (shipment.DestinationPostCode ?? "").Length >= 2 ? (shipment.DestinationPostCode ?? "")[..2].ToUpperInvariant() : (shipment.DestinationPostCode ?? "").ToUpperInvariant();

        var rate = await connection.QuerySingleOrDefaultAsync<KnRateRow>(new CommandDefinition("""
            SELECT TOP 1 agreedRate AS AgreedRate, minimumCharge AS MinimumCharge
            FROM log.RatesKN
            WHERE countryCode = @country AND postalCode = @prefix AND @weight >= minWeight AND @weight <= maxWeight
            """, new { country = (shipment.DestinationCountry ?? "").ToUpperInvariant(), prefix = postcodePrefix, weight = chargeableWeight }, cancellationToken: ct));

        if (rate is null)
        {
            var message = $"No KN rate found for {shipment.DestinationCountry} / postcode prefix {postcodePrefix} at {chargeableWeight} kg";
            return new CostEstimateResult(isKn, false, direction, tier, elementCode, false, chargeableWeight, grossWeight, volumetricWeight, null, null, null, customsCost, shipment.IncoTerms, message);
        }

        var rawCost = (rate.AgreedRate ?? 0m) * chargeableWeight;
        var minCharge = rate.MinimumCharge ?? 0m;
        var expectedCost = Math.Round(Math.Max(rawCost, minCharge), 2);

        return new CostEstimateResult(isKn, false, direction, tier, elementCode, true, chargeableWeight, grossWeight, volumetricWeight,
            rate.AgreedRate, rate.MinimumCharge, expectedCost, customsCost, shipment.IncoTerms, null);
    }

    internal static async Task<IReadOnlyList<ShipmentCostListRow>> GetUnprocessedAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ShipmentCostListRow>(new CommandDefinition(
            BuildCostListQuery("ISNULL(sc.migoStatus, 0) = 0", "plannedCollection ASC, ShipmentId ASC"), cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<IReadOnlyList<ShipmentCostListRow>> GetProcessedAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ShipmentCostListRow>(new CommandDefinition(
            BuildCostListQuery("ISNULL(sc.migoStatus, 0) = 1", "deliveredDate DESC, sc.costID DESC"), cancellationToken: ct));
        return rows.AsList();
    }

    /// <summary>
    /// Outbound + manual only — see this class's own header comment for why
    /// the inbound leg (log.PurchaseOrderShipment) is absent, deferred to
    /// Sub-phase 8b.
    /// </summary>
    private static string BuildCostListQuery(string migoPredicate, string orderBy) => $"""
        SELECT
            sc.costID AS CostId,
            'outbound' AS SourceType,
            'outbound' AS Direction,
            sm.shipmentID AS ShipmentId,
            RIGHT('00000000' + CONVERT(VARCHAR(12), sm.shipmentID), 8) AS ShipmentRef,
            sm.forwarderID AS ForwarderId,
            sm.plannedCollection AS PlannedCollection,
            sm.actualCollection AS ActualCollection,
            sm.ActualDelivery AS DeliveredDate,
            (SELECT TOP 1 forwarderName FROM log.Forwarders WHERE forwarderID = sm.forwarderID) AS ForwarderName,
            cc.centerCode AS CostCenter,
            ce.elementCode AS CostElement,
            sc.expectedCost AS ExpectedCost,
            sc.actualCost AS ActualCost,
            sc.costType AS CostType,
            sc.modeOfTransport AS ModeOfTransport,
            sm.destinationCountry AS DestinationCountry,
            sm.destinationPostCode AS DestinationPostCode,
            sm.trackingNumber AS TrackingNumber,
            sc.materialDocument AS MaterialDocument,
            sc.purchaseOrder AS PurchaseOrder
        FROM log.ShipmentCost sc
        INNER JOIN log.ShipmentMain sm ON sm.shipmentID = sc.shipmentID
        LEFT JOIN log.CostCenters cc ON cc.centerCode = sc.costCenter
        LEFT JOIN log.CostElements ce ON ce.elementCode = sc.costElement
        WHERE {migoPredicate} AND sc.shipmentID IS NOT NULL

        UNION ALL

        SELECT
            sc.costID AS CostId,
            'manual' AS SourceType,
            ISNULL(ce.direction, 'outbound') AS Direction,
            NULL AS ShipmentId,
            sc.manualReference AS ShipmentRef,
            sc.manualForwarderID AS ForwarderId,
            sc.manualIncurredDate AS PlannedCollection,
            sc.manualIncurredDate AS ActualCollection,
            sc.manualIncurredDate AS DeliveredDate,
            (SELECT TOP 1 forwarderName FROM log.Forwarders WHERE forwarderID = sc.manualForwarderID) AS ForwarderName,
            cc.centerCode AS CostCenter,
            ce.elementCode AS CostElement,
            sc.expectedCost AS ExpectedCost,
            sc.actualCost AS ActualCost,
            sc.costType AS CostType,
            sc.modeOfTransport AS ModeOfTransport,
            sc.manualCountry AS DestinationCountry,
            sc.manualPostcode AS DestinationPostCode,
            sc.manualTrackingNumber AS TrackingNumber,
            sc.materialDocument AS MaterialDocument,
            sc.purchaseOrder AS PurchaseOrder
        FROM log.ShipmentCost sc
        LEFT JOIN log.CostCenters cc ON cc.centerCode = sc.costCenter
        LEFT JOIN log.CostElements ce ON ce.elementCode = sc.costElement
        WHERE {migoPredicate} AND sc.shipmentID IS NULL AND sc.poShipmentID IS NULL

        ORDER BY {orderBy}
        """;

    private const string SelectAllColumns = """
        SELECT costID AS CostId, shipmentID AS ShipmentId, poShipmentID AS PoShipmentId, costType AS CostType, costElement AS CostElement, costCenter AS CostCenter,
            expectedCost AS ExpectedCost, actualCost AS ActualCost, migoStatus AS MigoStatus, materialDocument AS MaterialDocument, modeOfTransport AS ModeOfTransport, purchaseOrder AS PurchaseOrder,
            manualReference AS ManualReference, manualForwarderID AS ManualForwarderId, manualCountry AS ManualCountry, manualPostcode AS ManualPostcode, manualTrackingNumber AS ManualTrackingNumber, manualIncurredDate AS ManualIncurredDate
        """;

    private sealed class EstimateShipmentRow
    {
        public long ShipmentId { get; set; }
        public decimal? GrossWeight { get; set; }
        public decimal? ShipmentVolume { get; set; }
        public string? DestinationCountry { get; set; }
        public string? DestinationPostCode { get; set; }
        public long? OriginId { get; set; }
        public long? DestinationId { get; set; }
        public string? IncoTerms { get; set; }
        public string? ForwarderName { get; set; }
        public string? ForwarderMode { get; set; }
    }

    private sealed class KnRateRow
    {
        public decimal? AgreedRate { get; set; }
        public decimal? MinimumCharge { get; set; }
    }
}
