using Dapper;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Order-suggestion data layer — Logistics Sub-phase 8b (the engine itself,
/// computeOrderSuggestions/computeVendorOrderBuild/accept/manual, lands in
/// 8b.3). ListOpenIncomingOrdersAsync is ported now because 8b.2's Isopar
/// stock-risk needs it too — matches this migration's "port the shared piece
/// before its real caller ships" precedent (ForecastMathHelper's own header).
/// </summary>
internal static class PurchaseOrderSuggestionHelper
{
    // How far ahead to surface upcoming shortages, not just overdue ones — the order-suggestion
    // engine's own review window (8b.3), reused by Isopar stock-risk (8b.2) for the same "how far
    // ahead is a shortage worth surfacing" question.
    internal const int OrderReviewHorizonDays = 14;

    /// <summary>
    /// Open (not yet Received/Cancelled) accepted orders — nets "already incoming" quantity off a
    /// shortfall so a material already on order doesn't keep getting re-suggested (8b.3), and bumps
    /// a weekly stock forecast with expected deliveries (Isopar stock-risk here; /turns-valclass/history
    /// in 8b.b). DeliveryDate is the shipment's own live ExpectedEta once assigned to one, falling back
    /// to the order line's own (frozen, delivery-accuracy-tracking) DeliveryDate — see log.PurchaseOrderShipment.
    /// </summary>
    internal static async Task<IReadOnlyList<OpenIncomingOrderRow>> ListOpenIncomingOrdersAsync(INexusOperationsDb db, IReadOnlyList<string>? materials, CancellationToken ct)
    {
        var whereSql = "WHERE pos.Status IN ('Accepted', 'Ordered')";
        if (materials is { Count: > 0 }) whereSql += " AND pos.Material IN @materials";

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<OpenIncomingOrderRow>(new CommandDefinition($"""
            SELECT pos.SuggestionId, pos.Material, pos.OrderQty,
                   COALESCE(shp.ExpectedEta, pos.DeliveryDate) AS DeliveryDate,
                   pos.Status, pos.PoNumber
            FROM log.PurchaseOrderSuggestion pos
            LEFT JOIN log.PurchaseOrderShipment shp ON shp.ShipmentId = pos.ShipmentId
            {whereSql}
            """, new { materials }, cancellationToken: ct));
        return rows.AsList();
    }
}
