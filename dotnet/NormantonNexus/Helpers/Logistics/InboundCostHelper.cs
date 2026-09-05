using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Inbound Log cost tracking ("Associated Costs" on an existing shipment,
/// plus the cost line a Manual Inbound Shipment creates for itself) —
/// Logistics Sub-phase 8b.4. Port of routes/inboundcosts.js. This only adds/
/// lists/edits/removes lines in log.ShipmentCost — posting to SAP happens
/// through the SAME shared flow outbound freight costs use
/// (ShipmentCostController's POST /api/shipmentcost/post-migo, Sub-phase
/// 8a.5b), not a separate route here. Distinguished from an outbound line by
/// which FK is set: shipmentID (outbound) vs poShipmentID (inbound, this file).
/// </summary>
internal static class InboundCostHelper
{
    private const string InboundCostCenter = "0000002012";

    private sealed record ShipmentForCostRow(long ShipmentId, long? ForwarderId, bool IsManual);

    private sealed record CostLineForUpdateRow(long CostId, bool IsManual);

    internal static async Task<IReadOnlyList<InboundCostLineRow>> ListForShipmentAsync(INexusOperationsDb db, long poShipmentId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<InboundCostLineRow>(new CommandDefinition("""
            SELECT sc.costID AS CostId, sc.poShipmentID AS PoShipmentId, sc.costElement AS CostElement, sc.costCenter AS CostCenter, sc.costType AS CostType,
                   sc.expectedCost AS ExpectedCost, sc.actualCost AS ActualCost, sc.migoStatus AS MigoStatus, sc.materialDocument AS MaterialDocument, sc.modeOfTransport AS ModeOfTransport,
                   ce.elementDescription AS ElementDescription, ce.tier AS Tier
            FROM log.ShipmentCost sc
            LEFT JOIN log.CostElements ce ON ce.elementCode = sc.costElement AND ce.direction = 'inbound'
            WHERE sc.poShipmentID = @poShipmentId
            ORDER BY sc.costID DESC
            """, new { poShipmentId }, cancellationToken: ct));
        return rows.AsList();
    }

    /// <summary>
    /// Shared by "Add Cost" (AddAsync below) and Manual Inbound Shipment creation (InboundShipmentHelper,
    /// which auto-creates one line from its Price field) — modeOfTransport defaults from the shipment's
    /// own value when not supplied explicitly. costType is deliberately optional here (unlike AddAsync's
    /// own validation) since a Manual Inbound Shipment's auto-created line doesn't currently collect
    /// one — it can still be filled in afterward via UpdateAsync, and posting is blocked with a clear
    /// error (ShipmentCostHelper's own material-group resolution) until it is.
    /// </summary>
    internal static async Task<InsertedCostLineResult> InsertLineAsync(
        System.Data.IDbConnection connection, long poShipmentId, string? costCenter, string? costType, string? tier, decimal amount, string? modeOfTransport, CancellationToken ct)
    {
        var elementCode = await ShipmentCostHelper.ResolveCostElementAsync(connection, "inbound", tier == "premium" ? "premium" : "standard", null, ct);

        var mode = modeOfTransport;
        if (string.IsNullOrEmpty(mode))
        {
            mode = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
                "SELECT ModeOfTransport FROM log.PurchaseOrderShipment WHERE ShipmentId = @poShipmentId", new { poShipmentId }, cancellationToken: ct));
        }

        var costId = await connection.QuerySingleAsync<long>(new CommandDefinition("""
            INSERT INTO log.ShipmentCost (poShipmentID, costType, costElement, costCenter, expectedCost, actualCost, migoStatus, modeOfTransport)
            OUTPUT INSERTED.costID
            VALUES (@poShipmentId, @costType, @elementCode, @costCenter, @amount, @amount, 0, @mode)
            """, new { poShipmentId, costType, elementCode, costCenter = costCenter ?? InboundCostCenter, amount, mode }, cancellationToken: ct));

        return new InsertedCostLineResult(costId, elementCode);
    }

    /// <summary>
    /// Confirms the shipment exists and (softly) reports whether a forwarder is set yet — posting to
    /// SAP will fail without one, but adding the line itself doesn't need it. costCenter is only
    /// honored when the target shipment IsManual (a tracked Inbound Log shipment always uses the
    /// fixed inbound cost centre), silently ignored otherwise so a tracked shipment can't be pointed
    /// at a cost centre it shouldn't.
    /// </summary>
    internal static async Task<AddInboundCostLineResult> AddAsync(INexusOperationsDb db, AddInboundCostLineRequest body, CancellationToken ct)
    {
        if (body.PoShipmentId is null) throw new NexusValidationException("poShipmentID is required.");
        if (body.Amount is not > 0) throw new NexusValidationException("amount must be greater than 0.");
        if (string.IsNullOrWhiteSpace(body.CostType)) throw new NexusValidationException("costType is required.");

        using var connection = await db.CreateConnectionAsync(ct);

        var shipment = await connection.QuerySingleOrDefaultAsync<ShipmentForCostRow?>(new CommandDefinition(
            "SELECT ShipmentId, ForwarderID AS ForwarderId, IsManual FROM log.PurchaseOrderShipment WHERE ShipmentId = @poShipmentId",
            new { poShipmentId = body.PoShipmentId }, cancellationToken: ct));
        if (shipment is null) throw new NexusNotFoundException("Shipment not found.");

        var result = await InsertLineAsync(connection, body.PoShipmentId.Value, shipment.IsManual ? body.CostCenter : null, body.CostType.Trim(),
            body.Tier, body.Amount.Value, body.ModeOfTransport, ct);

        return new AddInboundCostLineResult(result.CostId, result.ElementCode, shipment.ForwarderId is not null);
    }

    /// <summary>
    /// Blocked once migoStatus=1 (reverse via ShipmentCostController's POST /api/shipmentcost/{costId}/reverse
    /// first — that drops it back into Unprocessed Costs and clears this guard). The JOIN to
    /// PurchaseOrderShipment (needed for IsManual) doubles as scope protection — costID is unique
    /// across the whole log.ShipmentCost table, so without it this could be pointed at an outbound
    /// or manual (non-inbound) line by id guessing; the JOIN naturally excludes both.
    /// </summary>
    internal static async Task<UpdateInboundCostLineResult> UpdateAsync(INexusOperationsDb db, long costId, UpdateInboundCostLineRequest body, CancellationToken ct)
    {
        if (body.Amount is not > 0) throw new NexusValidationException("amount must be greater than 0.");
        if (string.IsNullOrWhiteSpace(body.CostType)) throw new NexusValidationException("costType is required.");

        using var connection = await db.CreateConnectionAsync(ct);

        var row = await connection.QuerySingleOrDefaultAsync<CostLineForUpdateRow?>(new CommandDefinition("""
            SELECT sc.costID AS CostId, ps.IsManual AS IsManual
            FROM log.ShipmentCost sc
            JOIN log.PurchaseOrderShipment ps ON ps.ShipmentId = sc.poShipmentID
            WHERE sc.costID = @costId AND ISNULL(sc.migoStatus, 0) = 0
            """, new { costId }, cancellationToken: ct));
        if (row is null) throw new NexusValidationException("Line not found, or already posted to SAP.");

        var elementCode = await ShipmentCostHelper.ResolveCostElementAsync(connection, "inbound", body.Tier == "premium" ? "premium" : "standard", null, ct);
        var setCostCenter = row.IsManual && !string.IsNullOrEmpty(body.CostCenter);

        await connection.ExecuteAsync(new CommandDefinition($"""
            UPDATE log.ShipmentCost SET
              costElement = @elementCode, costType = @costType, expectedCost = @amount, actualCost = @amount
              {(setCostCenter ? ", costCenter = @costCenter" : "")}
            WHERE costID = @costId AND ISNULL(migoStatus, 0) = 0
            """, new { costId, elementCode, costType = body.CostType.Trim(), amount = body.Amount, costCenter = body.CostCenter }, cancellationToken: ct));

        return new UpdateInboundCostLineResult(costId, elementCode);
    }

    internal static async Task DeleteAsync(INexusOperationsDb db, long costId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var deleted = await connection.QuerySingleOrDefaultAsync<long?>(new CommandDefinition(
            "DELETE FROM log.ShipmentCost OUTPUT DELETED.costID WHERE costID = @costId AND ISNULL(migoStatus, 0) = 0", new { costId }, cancellationToken: ct));
        if (deleted is null) throw new NexusValidationException("Line not found, or already posted to SAP.");
    }
}
