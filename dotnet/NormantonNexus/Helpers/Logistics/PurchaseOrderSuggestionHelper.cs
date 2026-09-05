using System.Data;
using System.Globalization;
using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Order-suggestion engine (MRP Phase 2b) — Logistics Sub-phase 8b.3. Port of
/// routes/performance.js's computeOrderSuggestions/computeVendorOrderBuild/
/// enforceMaterialQty/validateVendorCombinedQty/buildAcceptPayload and the
/// /order-suggestions/* routes (list/build/preview/accept/accept-batch/manual/
/// manual-bulk/tracked/edit/patch-po-item/delete/assign-schedule-agreement) +
/// their performancesql.js backing queries. create-po/regenerate-pdf (real SAP
/// PO creation) are deferred to 8b.7; the Inbound Shipment tracking routes
/// below the order-suggestion section in performance.js are 8b.4.
///
/// ListOpenIncomingOrdersAsync was ported ahead of this slice in 8b.2 (Isopar
/// stock-risk needed it too) — see its own header comment.
/// </summary>
internal static class PurchaseOrderSuggestionHelper
{
    // How far ahead to surface upcoming shortages, not just overdue ones — the order-suggestion
    // engine's own review window (8b.3), reused by Isopar stock-risk (8b.2) for the same "how far
    // ahead is a shortage worth surfacing" question.
    internal const int OrderReviewHorizonDays = 14;
    // Extra cover beyond lead time, so the next order isn't due immediately.
    private const int OrderCoverageBufferDays = 30;
    // Fallback rounding increment (in the vendor's own order unit) for a material with no
    // MaterialMoqQty lot size on file, when that order unit differs from the material's SAP base
    // unit — e.g. rounds a raw 3006.303 LB shortfall to a clean 3000 LB.
    private const int OrderUnitRounding = 100;
    // How far ahead a daily-bucketed stock forecast runs for Isopar's always-daily preview, in
    // place of the usual 26-week horizon everyone else gets.
    private const int IsoparDailyForecastHorizonDays = 60;

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

    // ── Vendor-material rows joined with SAP snapshot data (log.VendorMaterial/log.Vendor/log.TurnsValClassSnapshot) ──

    internal static async Task<IReadOnlyList<VendorMaterialForSuggestionRow>> ListVendorMaterialsForSuggestionsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<VendorMaterialForSuggestionRow>(new CommandDefinition("""
            SELECT
              vm.VendorMaterialId, vm.VendorId, vm.Material, vm.MaterialMoqQty, vm.MaterialMaxQty,
              vm.LeadTimeDaysOverride, vm.MinSafetyStockQty, vm.ScheduleAgreement,
              v.VendorName, v.Incoterms, v.OrderMoqQty, v.OrderMaxQty, v.OrderMoqUom,
              v.DefaultLeadTimeDays, v.TransitTimeDays,
              t.MaterialText, t.Uom, t.MrpController, t.StockQty, t.ConsignmentQty,
              t.SafetyStock AS SapSafetyStock, t.PlannedDeliveryTime AS SapLeadTimeDays,
              t.PredictedM12, t.PredictedM11, t.PredictedM10, t.PredictedM09, t.PredictedM08, t.PredictedM07,
              t.PredictedM06, t.PredictedM05, t.PredictedM04, t.PredictedM03, t.PredictedM02, t.PredictedM01, t.PredictedM00
            FROM log.VendorMaterial vm
            JOIN log.Vendor v ON v.VendorId = vm.VendorId
            LEFT JOIN log.TurnsValClassSnapshot t ON t.Material = vm.Material
            ORDER BY vm.Material
            """, cancellationToken: ct));
        return rows.AsList();
    }

    // ── Live "what needs ordering" computation — nothing persisted until accepted ──

    internal static async Task<IReadOnlyList<VendorSuggestionGroup>> ComputeOrderSuggestionsGroupedAsync(INexusOperationsDb db, CancellationToken ct)
    {
        var suggestions = await ComputeOrderSuggestionsAsync(db, ct);
        return GroupSuggestionsByVendor(suggestions);
    }

    private static async Task<IReadOnlyList<OrderSuggestion>> ComputeOrderSuggestionsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        var rows = await ListVendorMaterialsForSuggestionsAsync(db, ct);
        var incoming = await ListOpenIncomingOrdersAsync(db, null, ct);
        var adjustments = await VendorMasterDataHelper.ListDemandAdjustmentsAsync(db, null, ct);
        var isoparContext = await IsoparHelper.GetForecastContextAsync(db, ct);

        var incomingByMaterial = GroupIncomingByMaterial(incoming);
        var adjustmentsByMaterial = GroupAdjustmentsByMaterial(adjustments);

        var today = DateTime.UtcNow;
        var asOfDate = new DateTime(today.Year, today.Month, today.Day, 0, 0, 0, DateTimeKind.Utc);
        var horizonDate = asOfDate.AddDays(OrderReviewHorizonDays);

        var suggestions = new List<OrderSuggestion>();
        foreach (var r in rows)
        {
            var built = BuildSuggestionForRow(r, incomingByMaterial, today, asOfDate, horizonDate, adjustmentsByMaterial, isoparContext);
            if (built is not null && built.DueNow && built.SuggestedQty > 0) suggestions.Add(built);
        }

        return suggestions.OrderBy(s => s.OrderByDate, StringComparer.Ordinal).ToList();
    }

    /// <summary>Every material a vendor supplies (not just the ones currently due) so the Build Order modal can offer pulling a not-yet-urgent material into the order to help clear a combined MOQ.</summary>
    internal static async Task<VendorOrderBuildResult> ComputeVendorOrderBuildAsync(INexusOperationsDb db, long vendorId, CancellationToken ct)
    {
        var rows = await ListVendorMaterialsForSuggestionsAsync(db, ct);
        var incoming = await ListOpenIncomingOrdersAsync(db, null, ct);
        var adjustments = await VendorMasterDataHelper.ListDemandAdjustmentsAsync(db, null, ct);
        var isoparContext = await IsoparHelper.GetForecastContextAsync(db, ct);

        var incomingByMaterial = GroupIncomingByMaterial(incoming);
        var adjustmentsByMaterial = GroupAdjustmentsByMaterial(adjustments);

        var today = DateTime.UtcNow;
        var asOfDate = new DateTime(today.Year, today.Month, today.Day, 0, 0, 0, DateTimeKind.Utc);
        var horizonDate = asOfDate.AddDays(OrderReviewHorizonDays);

        var vendorRows = rows.Where(r => r.VendorId == vendorId).ToList();
        var materials = new List<OrderSuggestion>();
        string? vendorName = null;
        decimal? orderMoqQty = null, orderMaxQty = null, defaultLeadTimeDays = null;
        string? orderMoqUom = null;

        foreach (var r in vendorRows)
        {
            vendorName = r.VendorName;
            orderMoqQty = r.OrderMoqQty;
            orderMaxQty = r.OrderMaxQty;
            orderMoqUom = r.OrderMoqUom;
            defaultLeadTimeDays = r.DefaultLeadTimeDays;
            var built = BuildSuggestionForRow(r, incomingByMaterial, today, asOfDate, horizonDate, adjustmentsByMaterial, isoparContext);
            if (built is not null) materials.Add(built);
        }

        var sortedMaterials = materials
            .OrderByDescending(m => m.DueNow)
            .ThenBy(m => m.OrderByDate ?? "9999", StringComparer.Ordinal)
            .ToList();

        // defaultLeadTimeDays lets the "Start New Order" builder pre-fill a delivery date before
        // any material is checked yet.
        return new VendorOrderBuildResult(vendorId, vendorName, orderMoqQty, orderMaxQty, orderMoqUom, defaultLeadTimeDays, sortedMaterials);
    }

    private static Dictionary<string, List<OpenIncomingOrderRow>> GroupIncomingByMaterial(IEnumerable<OpenIncomingOrderRow> incoming)
    {
        var map = new Dictionary<string, List<OpenIncomingOrderRow>>();
        foreach (var r in incoming)
        {
            if (!map.TryGetValue(r.Material, out var list)) { list = []; map[r.Material] = list; }
            list.Add(r);
        }
        return map;
    }

    private static Dictionary<string, List<ForecastMathHelper.DemandAdjustmentWindow>> GroupAdjustmentsByMaterial(IEnumerable<DemandAdjustmentRow> adjustments)
    {
        var map = new Dictionary<string, List<ForecastMathHelper.DemandAdjustmentWindow>>();
        foreach (var r in adjustments)
        {
            if (!map.TryGetValue(r.Material, out var list)) { list = []; map[r.Material] = list; }
            list.Add(new ForecastMathHelper.DemandAdjustmentWindow(r.StartDate, r.EndDate, r.UsagePercent));
        }
        return map;
    }

    /// <summary>
    /// One vendor-material row's full suggestion picture. Returns null only when there's no SAP
    /// snapshot to compute from at all (r.StockQty and r.ConsignmentQty both null).
    /// </summary>
    internal static OrderSuggestion? BuildSuggestionForRow(
        VendorMaterialForSuggestionRow r,
        IReadOnlyDictionary<string, List<OpenIncomingOrderRow>> incomingByMaterial,
        DateTime today, DateTime asOfDate, DateTime horizonDate,
        IReadOnlyDictionary<string, List<ForecastMathHelper.DemandAdjustmentWindow>> adjustmentsByMaterial,
        IsoparForecastContext? isoparContext)
    {
        if (r.StockQty is null && r.ConsignmentQty is null) return null;

        var openOrders = incomingByMaterial.TryGetValue(r.Material, out var oo) ? oo : [];
        var openQty = openOrders.Sum(o => o.OrderQty);
        var materialAdjustments = adjustmentsByMaterial.TryGetValue(r.Material, out var adj) ? (IReadOnlyList<ForecastMathHelper.DemandAdjustmentWindow>)adj : [];

        var onHandStock = (r.StockQty ?? 0m) + (r.ConsignmentQty ?? 0m);
        var predictedMonthly = new[]
        {
            r.PredictedM12 ?? 0m, r.PredictedM11 ?? 0m, r.PredictedM10 ?? 0m, r.PredictedM09 ?? 0m, r.PredictedM08 ?? 0m, r.PredictedM07 ?? 0m,
            r.PredictedM06 ?? 0m, r.PredictedM05 ?? 0m, r.PredictedM04 ?? 0m, r.PredictedM03 ?? 0m, r.PredictedM02 ?? 0m, r.PredictedM01 ?? 0m, r.PredictedM00 ?? 0m,
        };

        // ── Isopar override (Material 10010) — planned off a manually-entered daily meter
        // reading + fixed weekday/weekend L/day rate instead of SAP's StockQty/PredictedUsage.
        var isIsopar = r.Material == IsoparPeriodHelper.IsoparMaterial;
        var isoparReading = isIsopar ? isoparContext?.LatestReading : null;
        var usingMeterReading = isIsopar && isoparReading is not null;
        var effectiveOnHandStock = usingMeterReading ? isoparReading!.ReadingQty : onHandStock;
        var isoparDailyUsageFnOverride = (isIsopar && isoparContext?.PlanningRate is not null)
            ? ForecastMathHelper.MakeIsoparDailyUsageFn(isoparContext.PlanningRate.WeekdayRateLPerDay, isoparContext.PlanningRate.WeekendRateLPerDay)
            : null;

        // Manually-maintained floor takes priority over SAP's EISBE.
        var safetyStockQty = r.MinSafetyStockQty ?? r.SapSafetyStock ?? 0m;

        // Each open order bumps the forecast only in the week it's actually due, not from today —
        // orders with no recorded DeliveryDate fall back to "today" (asOfDate).
        var incomingDeliveries = openOrders
            .Select(o => new ForecastMathHelper.IncomingDelivery(o.DeliveryDate ?? asOfDate, o.OrderQty))
            .ToList();

        var weeklyForecast = ForecastMathHelper.BuildWeeklyStockForecast(effectiveOnHandStock, predictedMonthly, today, incomingDeliveries, materialAdjustments, isoparDailyUsageFnOverride);
        var breachDate = ForecastMathHelper.FindStockBelowThresholdDate(weeklyForecast, asOfDate, safetyStockQty);

        var leadTimeDays = r.LeadTimeDaysOverride ?? r.SapLeadTimeDays ?? r.DefaultLeadTimeDays ?? 0m;
        var orderByDate = breachDate.HasValue ? ForecastMathHelper.AddWorkingDaysUtc(breachDate.Value, -leadTimeDays) : (DateTime?)null;
        var dueNow = orderByDate.HasValue && orderByDate.Value <= horizonDate;
        var urgency = breachDate is null ? "NotDue" : (orderByDate!.Value < asOfDate ? "Overdue" : (dueNow ? "DueSoon" : "Upcoming"));

        // Suggested qty: cover lead time + a review-cycle buffer, rebuild the safety-stock floor,
        // minus what's already on hand or already incoming. Unlike the breach-date forecast above,
        // sizing a NEW order nets off the FULL open-order quantity regardless of timing.
        var currentStock = effectiveOnHandStock + openQty;
        var suggestedQty = 0m;
        if (breachDate.HasValue)
        {
            var coverageDays = leadTimeDays + OrderCoverageBufferDays;
            var demandOverCoverage = ForecastMathHelper.DemandOverDays(predictedMonthly, asOfDate, coverageDays, materialAdjustments, isoparDailyUsageFnOverride);
            var qty = demandOverCoverage + safetyStockQty - currentStock;
            if (qty > 0)
            {
                var moq = r.MaterialMoqQty ?? 0m;
                var max = r.MaterialMaxQty ?? 0m;
                var baseUom = r.Uom ?? "KG";
                var orderUnit = r.OrderMoqUom ?? baseUom;

                if (!string.Equals(orderUnit, baseUom, StringComparison.OrdinalIgnoreCase))
                {
                    var qtyInOrderUnit = UnitConversionHelper.ConvertQty(qty, baseUom, orderUnit);
                    decimal roundedInOrderUnit;
                    if (dueNow && moq > 0)
                    {
                        roundedInOrderUnit = Math.Ceiling(qtyInOrderUnit / moq) * moq;
                        if (max > 0) roundedInOrderUnit = EnforceMaterialQty(roundedInOrderUnit, moq, max);
                    }
                    else if (dueNow)
                    {
                        roundedInOrderUnit = Math.Max(OrderUnitRounding, Math.Round(qtyInOrderUnit / OrderUnitRounding, MidpointRounding.AwayFromZero) * OrderUnitRounding);
                    }
                    else
                    {
                        roundedInOrderUnit = qtyInOrderUnit;
                    }
                    suggestedQty = UnitConversionHelper.ConvertQty(roundedInOrderUnit, orderUnit, baseUom);
                }
                else
                {
                    var rounded = (dueNow && moq > 0) ? Math.Ceiling(qty / moq) * moq : qty;
                    suggestedQty = (dueNow && max > 0) ? EnforceMaterialQty(rounded, moq, max) : Math.Round(rounded, 3, MidpointRounding.AwayFromZero);
                }
            }
        }

        // Transit time feeds the expected-dispatch-date calc for every Incoterm, not just EXW.
        var transitTimeDays = r.TransitTimeDays ?? 0m;

        var isoparInfo = isIsopar
            ? new IsoparMeterReadingInfo(
                usingMeterReading,
                isoparReading?.ReadingDate.ToString("yyyy-MM-dd"),
                usingMeterReading ? null : "No Isopar meter reading recorded yet — showing SAP stock figures until the first reading is entered.")
            : null;

        return new OrderSuggestion(
            r.VendorMaterialId, r.VendorId, r.VendorName, r.Material, r.MaterialText, r.Uom, r.MrpController,
            Math.Round(currentStock, 3, MidpointRounding.AwayFromZero), Math.Round(openQty, 3, MidpointRounding.AwayFromZero), safetyStockQty,
            breachDate?.ToString("yyyy-MM-dd"), leadTimeDays, transitTimeDays,
            orderByDate?.ToString("yyyy-MM-dd"), urgency, dueNow, suggestedQty,
            r.MaterialMoqQty, r.MaterialMaxQty, r.OrderMoqQty, r.OrderMaxQty, r.OrderMoqUom,
            r.Incoterms, string.IsNullOrEmpty(r.ScheduleAgreement), r.ScheduleAgreement, isoparInfo);
    }

    /// <summary>Groups the flat "needs ordering" list by vendor and tallies the running total against that vendor's combined order-level MOQ.</summary>
    internal static IReadOnlyList<VendorSuggestionGroup> GroupSuggestionsByVendor(IReadOnlyList<OrderSuggestion> suggestions)
    {
        var order = new List<long>();
        var groups = new Dictionary<long, (string VendorName, decimal? OrderMoqQty, decimal? OrderMaxQty, string? OrderMoqUom, List<OrderSuggestion> Materials)>();
        foreach (var s in suggestions)
        {
            if (!groups.ContainsKey(s.VendorId))
            {
                groups[s.VendorId] = (s.VendorName, s.OrderMoqQty, s.OrderMaxQty, s.OrderMoqUom, []);
                order.Add(s.VendorId);
            }
            groups[s.VendorId].Materials.Add(s);
        }

        var result = order.Select(vendorId =>
        {
            var g = groups[vendorId];
            // Each material's suggestedQty is in its own SAP base unit (effectively always KG),
            // but orderMoqQty/orderMaxQty are in the vendor's OWN order unit, so the combined
            // total must be converted before comparing against either threshold.
            var combinedQty = g.Materials.Sum(m => m.SuggestedQty);
            var combinedQtyInOrderUnit = UnitConversionHelper.ConvertQty(combinedQty, "KG", g.OrderMoqUom ?? "KG");
            // Exact-quantity vendor (e.g. Raaj Ratna: exactly 20,000kg, not just at least).
            var isExactQty = g.OrderMoqQty is > 0 && g.OrderMaxQty is > 0 && g.OrderMoqQty == g.OrderMaxQty;
            var moqShortfall = g.OrderMoqQty is > 0 ? Math.Max(0m, g.OrderMoqQty.Value - combinedQtyInOrderUnit) : 0m;
            var moqOverage = g.OrderMaxQty is > 0 ? Math.Max(0m, combinedQtyInOrderUnit - g.OrderMaxQty.Value) : 0m;
            var earliestOrderByDate = g.Materials.Where(m => m.OrderByDate is not null).Select(m => m.OrderByDate).OrderBy(d => d, StringComparer.Ordinal).FirstOrDefault();

            var roundedShortfall = Math.Round(moqShortfall, 3, MidpointRounding.AwayFromZero);
            var roundedOverage = Math.Round(moqOverage, 3, MidpointRounding.AwayFromZero);
            return new VendorSuggestionGroup(
                vendorId, g.VendorName, g.OrderMoqQty, g.OrderMaxQty, g.OrderMoqUom, g.Materials,
                Math.Round(combinedQty, 3, MidpointRounding.AwayFromZero), isExactQty,
                moqShortfall <= 0.001m && moqOverage <= 0.001m, roundedShortfall, roundedOverage, earliestOrderByDate);
        }).ToList();

        return result.OrderBy(g => g.EarliestOrderByDate ?? "9999", StringComparer.Ordinal).ToList();
    }

    /// <summary>A material's own lot size (MaterialMoqQty) and cap (MaterialMaxQty) are ENFORCED, not just hinted at — a quantity that isn't a whole number of lots literally can't be supplied. Snaps to the NEAREST multiple (not always up), since this also runs against manually-typed quantities.</summary>
    internal static decimal EnforceMaterialQty(decimal qty, decimal? materialMoqQty, decimal? materialMaxQty)
    {
        var q = qty;
        var moq = materialMoqQty ?? 0m;
        if (moq > 0)
        {
            q = Math.Round(q / moq, MidpointRounding.AwayFromZero) * moq;
            if (q <= 0) q = moq; // never snap a genuinely-entered qty all the way to zero
        }
        var max = materialMaxQty ?? 0m;
        if (max > 0 && q > max)
        {
            // Clamp to the largest whole lot that still fits under the cap, if the lot size
            // divides in; otherwise just clamp straight to the cap.
            q = moq > 0 ? Math.Floor(max / moq) * moq : max;
            if (q <= 0) q = max;
        }
        return Math.Round(q, 3, MidpointRounding.AwayFromZero);
    }

    /// <summary>Vendor-level combined min/max/exact can't be auto-corrected the way a single material's lot size can. Enforced as a hard block instead: returns an error message when the total doesn't satisfy the vendor's requirement, or null when it does.</summary>
    internal static string? ValidateVendorCombinedQty(decimal totalQty, decimal? orderMoqQty, decimal? orderMaxQty)
    {
        var total = Math.Round(totalQty, 3, MidpointRounding.AwayFromZero);
        var min = orderMoqQty;
        var max = orderMaxQty;

        if (min is > 0 && max is > 0 && min == max)
        {
            if (Math.Abs(total - min.Value) > 0.001m)
                return $"This vendor requires an exact combined order of {FormatQty(min.Value)} — this order totals {FormatQty(total)}.";
            return null;
        }
        if (min is > 0 && total < min.Value - 0.001m)
            return $"This vendor requires a combined order of at least {FormatQty(min.Value)} — this order totals {FormatQty(total)}.";
        if (max is > 0 && total > max.Value + 0.001m)
            return $"This vendor's combined order cannot exceed {FormatQty(max.Value)} — this order totals {FormatQty(total)}.";
        return null;
    }

    private static string FormatQty(decimal value) => value.ToString("#,##0.###", CultureInfo.InvariantCulture);

    /// <summary>Shared date-math for accepting a suggestion, used by the single-item and batch accept routes plus manual order entry.</summary>
    internal readonly record struct AcceptPayload(
        long VendorMaterialId, long VendorId, string Material, decimal? SuggestedQty, decimal OrderQty, DateTime OrderDate,
        decimal LeadTimeDaysUsed, DateTime DeliveryDate, decimal TransitTimeDaysUsed, DateTime ReadyToCollectDate, bool IsSpotPo, string? Notes);

    internal static AcceptPayload BuildAcceptPayload(
        long vendorMaterialId, long vendorId, string material, decimal? suggestedQty, decimal orderQty, DateTime orderDate,
        decimal? leadTimeDays, decimal? transitTimeDays, bool? isSpotPo, string? notes, DateTime? deliveryDateOverride)
    {
        var leadTime = leadTimeDays ?? 0m;
        // A user-entered delivery date takes priority over the lead-time-derived one.
        var deliveryDate = deliveryDateOverride ?? ForecastMathHelper.AddWorkingDaysUtc(orderDate, leadTime);
        // The expected dispatch date, computed for EVERY order regardless of Incoterm — useful
        // universally for spotting a late dispatch, not just for who's contractually arranging transit.
        var transitTime = transitTimeDays ?? 0m;
        var readyToCollectDate = ForecastMathHelper.AddWorkingDaysUtc(deliveryDate, -transitTime);

        return new AcceptPayload(vendorMaterialId, vendorId, material, suggestedQty, orderQty, orderDate, leadTime, deliveryDate, transitTime, readyToCollectDate, isSpotPo ?? false, notes);
    }

    private static async Task<long> InsertAcceptedOrderAsync(IDbConnection connection, AcceptPayload payload, CancellationToken ct) =>
        await connection.QuerySingleAsync<long>(new CommandDefinition("""
            INSERT INTO log.PurchaseOrderSuggestion
              (VendorId, VendorMaterialId, Material, Status, SuggestedQty, OrderQty, OrderDate,
               LeadTimeDaysUsed, DeliveryDate, TransitTimeDaysUsed, ReadyToCollectDate, IsSpotPo, Notes)
            OUTPUT INSERTED.SuggestionId
            VALUES
              (@VendorId, @VendorMaterialId, @Material, 'Accepted', @SuggestedQty, @OrderQty, @OrderDate,
               @LeadTimeDaysUsed, @DeliveryDate, @TransitTimeDaysUsed, @ReadyToCollectDate, @IsSpotPo, @Notes)
            """, payload, cancellationToken: ct));

    // ── Preview — live "what if" for Start New Order / Build Order, nothing persisted ──

    internal static async Task<IReadOnlyList<OrderSuggestionPreviewResult>> PreviewAsync(INexusOperationsDb db, OrderSuggestionPreviewRequest body, CancellationToken ct)
    {
        if (body.Items is not { Count: > 0 }) throw new NexusValidationException("A non-empty items array is required.");
        if (body.DeliveryDate is null) throw new NexusValidationException("A valid deliveryDate is required.");
        var deliveryDate = body.DeliveryDate.Value;

        var materials = body.Items.Select(i => i.Material).Where(m => !string.IsNullOrEmpty(m)).Distinct().ToList();

        var rows = await ListVendorMaterialsForSuggestionsAsync(db, ct);
        var incoming = await ListOpenIncomingOrdersAsync(db, materials, ct);
        var adjustments = await VendorMasterDataHelper.ListDemandAdjustmentsAsync(db, materials, ct);
        var isoparContext = await IsoparHelper.GetForecastContextAsync(db, ct);

        var incomingByMaterial = GroupIncomingByMaterial(incoming);
        var adjustmentsByMaterial = GroupAdjustmentsByMaterial(adjustments);
        var rowsByMaterial = rows.GroupBy(r => r.Material).ToDictionary(g => g.Key, g => g.First());

        var now = DateTime.UtcNow;
        var results = new List<OrderSuggestionPreviewResult>();

        foreach (var item in body.Items)
        {
            if (!rowsByMaterial.TryGetValue(item.Material, out var r))
            {
                results.Add(new OrderSuggestionPreviewResult(item.Material, null, null, "Material not found in MRP master data."));
                continue;
            }

            var onHandStock = (r.StockQty ?? 0m) + (r.ConsignmentQty ?? 0m);
            var predictedMonthly = new[]
            {
                r.PredictedM12 ?? 0m, r.PredictedM11 ?? 0m, r.PredictedM10 ?? 0m, r.PredictedM09 ?? 0m, r.PredictedM08 ?? 0m, r.PredictedM07 ?? 0m,
                r.PredictedM06 ?? 0m, r.PredictedM05 ?? 0m, r.PredictedM04 ?? 0m, r.PredictedM03 ?? 0m, r.PredictedM02 ?? 0m, r.PredictedM01 ?? 0m, r.PredictedM00 ?? 0m,
            };

            // Same Isopar override as BuildSuggestionForRow, but the override function additionally
            // requires a real meter reading to exist here (not just a configured rate) — a real,
            // confirmed asymmetry with BuildSuggestionForRow, kept exactly as Node has it.
            var isIsopar = r.Material == IsoparPeriodHelper.IsoparMaterial;
            var isoparReading = isIsopar ? isoparContext.LatestReading : null;
            var effectiveOnHandStock = (isIsopar && isoparReading is not null) ? isoparReading.ReadingQty : onHandStock;
            var isoparDailyUsageFnOverride = (isIsopar && isoparReading is not null && isoparContext.PlanningRate is not null)
                ? ForecastMathHelper.MakeIsoparDailyUsageFn(isoparContext.PlanningRate.WeekdayRateLPerDay, isoparContext.PlanningRate.WeekendRateLPerDay)
                : null;

            var realDeliveries = (incomingByMaterial.TryGetValue(item.Material, out var openOrders) ? openOrders : [])
                .Where(o => o.DeliveryDate.HasValue)
                .Select(o => new ForecastMathHelper.IncomingDelivery(o.DeliveryDate!.Value, o.OrderQty, o.SuggestionId, o.PoNumber))
                .ToList();
            // The hypothetical draft order has no real SuggestionId yet — tagged distinctly so the
            // frontend can style/label it apart from real deliveries.
            var draftDelivery = new ForecastMathHelper.IncomingDelivery(deliveryDate, item.OrderQty ?? 0m, null, "Draft");
            var materialAdjustments = adjustmentsByMaterial.TryGetValue(item.Material, out var adj) ? (IReadOnlyList<ForecastMathHelper.DemandAdjustmentWindow>)adj : [];

            var bucketDays = isIsopar ? 1 : 7;
            var stockForecast = ForecastMathHelper.BuildWeeklyStockForecast(
                effectiveOnHandStock, predictedMonthly, now, [.. realDeliveries, draftDelivery], materialAdjustments, isoparDailyUsageFnOverride, bucketDays);
            var horizon = isIsopar ? IsoparDailyForecastHorizonDays : 26;
            stockForecast = stockForecast with { Weeks = stockForecast.Weeks.Take(horizon).ToList() };

            results.Add(new OrderSuggestionPreviewResult(item.Material, r.MaterialText, ToDto(stockForecast), null));
        }

        return results;
    }

    private static WeeklyStockForecastDto ToDto(ForecastMathHelper.WeeklyStockForecast forecast) =>
        new(forecast.AsOfDate, forecast.CurrentStock,
            forecast.Weeks.Select(w => new ForecastWeekDto(w.WeekEnding, w.WeeklyUsage, w.IncomingQty,
                w.Deliveries.Select(d => new ForecastDeliveryDto(d.Id, d.PoNumber, d.Qty, d.Material)).ToList(),
                w.ExpectedStock)).ToList(),
            forecast.BucketDays);

    // ── Accept (single + batch) ───────────────────────────────────────────

    internal static async Task<AcceptOrderSuggestionResult> AcceptAsync(INexusOperationsDb db, AcceptOrderSuggestionRequest body, CancellationToken ct)
    {
        if (body.VendorMaterialId is null || body.VendorId is null || string.IsNullOrEmpty(body.Material) || body.OrderQty is not > 0)
            throw new NexusValidationException("vendorMaterialId, vendorId, material and orderQty are required.");

        using var connection = await db.CreateConnectionAsync(ct);

        // Enforced fresh from the DB, not trusted from the client.
        var materialConstraints = await connection.QuerySingleOrDefaultAsync<VendorMaterialConstraints?>(new CommandDefinition(
            "SELECT MaterialMoqQty, MaterialMaxQty FROM log.VendorMaterial WHERE VendorMaterialId = @vendorMaterialId", new { vendorMaterialId = body.VendorMaterialId }, cancellationToken: ct));
        var vendorConstraints = await connection.QuerySingleOrDefaultAsync<VendorOrderConstraints?>(new CommandDefinition(
            "SELECT VendorName, OrderMoqQty, OrderMaxQty, OrderMoqUom FROM log.Vendor WHERE VendorId = @vendorId", new { vendorId = body.VendorId }, cancellationToken: ct));

        var enforcedQty = EnforceMaterialQty(body.OrderQty.Value, materialConstraints?.MaterialMoqQty, materialConstraints?.MaterialMaxQty);

        // A single-material accept can only ever satisfy a vendor's combined requirement if this
        // one material's qty alone clears it. If it doesn't, block and point at Build Order rather
        // than silently accepting a short/over order.
        if (vendorConstraints is not null && (vendorConstraints.OrderMoqQty is > 0 || vendorConstraints.OrderMaxQty is > 0))
        {
            var vendorError = ValidateVendorCombinedQty(enforcedQty, vendorConstraints.OrderMoqQty, vendorConstraints.OrderMaxQty);
            if (vendorError is not null)
                throw new NexusValidationException($"{vendorError} Use Build Order to combine materials from this vendor into one order.");
        }

        var orderDate = body.OrderDate ?? DateTime.UtcNow;
        var payload = BuildAcceptPayload(body.VendorMaterialId.Value, body.VendorId.Value, body.Material, body.SuggestedQty, enforcedQty, orderDate,
            body.LeadTimeDays, body.TransitTimeDays, body.IsSpotPo, body.Notes, body.DeliveryDate);
        var suggestionId = await InsertAcceptedOrderAsync(connection, payload, ct);

        return new AcceptOrderSuggestionResult(suggestionId, enforcedQty);
    }

    /// <summary>Combines several materials from one vendor into a single accepted order — the Build Order modal's submit path, for clearing a vendor's combined order-level MOQ. The vendor-level combined check runs BEFORE anything is persisted, so a batch that doesn't satisfy it is rejected outright, not partially saved.</summary>
    internal static async Task<AcceptOrderSuggestionBatchResult> AcceptBatchAsync(INexusOperationsDb db, AcceptOrderSuggestionBatchRequest body, CancellationToken ct)
    {
        if (body.VendorId is null || body.Items is not { Count: > 0 })
            throw new NexusValidationException("vendorId and a non-empty items array are required.");

        var validItems = body.Items.Where(i => i.VendorMaterialId is not null && !string.IsNullOrEmpty(i.Material) && i.OrderQty is > 0).ToList();
        if (validItems.Count == 0)
            throw new NexusValidationException("No valid items to accept — each item needs vendorMaterialId, material and orderQty > 0.");

        using var connection = await db.CreateConnectionAsync(ct);

        // Enforce each item's own lot size/max first (fresh from the DB), then validate the
        // enforced total against the vendor's combined requirement — all before anything is
        // written, so this is all-or-nothing.
        var constraintsByVmId = new Dictionary<long, VendorMaterialConstraints?>();
        foreach (var item in validItems)
        {
            var vmId = item.VendorMaterialId!.Value;
            if (!constraintsByVmId.ContainsKey(vmId))
            {
                constraintsByVmId[vmId] = await connection.QuerySingleOrDefaultAsync<VendorMaterialConstraints?>(new CommandDefinition(
                    "SELECT MaterialMoqQty, MaterialMaxQty FROM log.VendorMaterial WHERE VendorMaterialId = @vmId", new { vmId }, cancellationToken: ct));
            }
        }

        var enforcedItems = validItems.Select(item =>
        {
            var c = constraintsByVmId[item.VendorMaterialId!.Value];
            return item with { OrderQty = EnforceMaterialQty(item.OrderQty!.Value, c?.MaterialMoqQty, c?.MaterialMaxQty) };
        }).ToList();

        var vendorConstraints = await connection.QuerySingleOrDefaultAsync<VendorOrderConstraints?>(new CommandDefinition(
            "SELECT VendorName, OrderMoqQty, OrderMaxQty, OrderMoqUom FROM log.Vendor WHERE VendorId = @vendorId", new { vendorId = body.VendorId }, cancellationToken: ct));

        var total = enforcedItems.Sum(i => i.OrderQty ?? 0m);
        if (vendorConstraints is not null && (vendorConstraints.OrderMoqQty is > 0 || vendorConstraints.OrderMaxQty is > 0))
        {
            var vendorError = ValidateVendorCombinedQty(total, vendorConstraints.OrderMoqQty, vendorConstraints.OrderMaxQty);
            if (vendorError is not null) throw new NexusValidationException(vendorError);
        }

        var orderDate = body.OrderDate ?? DateTime.UtcNow;
        var suggestionIds = new List<long>();
        foreach (var item in enforcedItems)
        {
            var payload = BuildAcceptPayload(item.VendorMaterialId!.Value, body.VendorId.Value, item.Material!, item.SuggestedQty, item.OrderQty!.Value, orderDate,
                item.LeadTimeDays, item.TransitTimeDays, item.IsSpotPo, item.Notes, item.DeliveryDate);
            suggestionIds.Add(await InsertAcceptedOrderAsync(connection, payload, ct));
        }

        return new AcceptOrderSuggestionBatchResult(suggestionIds, Math.Round(total, 3, MidpointRounding.AwayFromZero));
    }

    // ── Manual order entry (single + bulk CSV) — records an order that already exists outside the suggestion engine ──

    internal static async Task<ManualOrderResult> ManualAsync(INexusOperationsDb db, ManualOrderRequest body, CancellationToken ct)
    {
        if (body.VendorMaterialId is null) throw new NexusValidationException("vendorMaterialId is required.");

        var allRows = await ListVendorMaterialsForSuggestionsAsync(db, ct);
        using var connection = await db.CreateConnectionAsync(ct);
        var suggestionId = await InsertManualOrderRowAsync(connection, body, allRows, ct);
        return new ManualOrderResult(suggestionId);
    }

    /// <summary>Every row is attempted independently — a typo in row 12 shouldn't block rows 1-11 from saving — so the response reports success/failure per row rather than all-or-nothing.</summary>
    internal static async Task<ManualOrderBulkResult> ManualBulkAsync(INexusOperationsDb db, ManualOrderBulkRequest body, CancellationToken ct)
    {
        if (body.Rows is not { Count: > 0 }) throw new NexusValidationException("rows must be a non-empty array.");

        var allRows = await ListVendorMaterialsForSuggestionsAsync(db, ct);
        using var connection = await db.CreateConnectionAsync(ct);

        var results = new List<ManualOrderBulkRowResult>();
        for (var i = 0; i < body.Rows.Count; i++)
        {
            var csvRow = body.Rows[i];
            var rowNum = i + 2; // +1 for 1-indexing, +1 for the header row
            try
            {
                var match = FindVendorMaterial(allRows, csvRow.Vendor, csvRow.Material);
                if (match is null)
                    throw new NexusValidationException($"No vendor material configured for \"{csvRow.Vendor ?? "?"}\" / \"{csvRow.Material ?? "?"}\" — add it in Vendor Master Data first.");

                var manualRequest = new ManualOrderRequest(match.VendorMaterialId, csvRow.OrderQty, csvRow.OrderDate, csvRow.DeliveryDate, csvRow.PoNumber, csvRow.Notes, csvRow.Status, csvRow.SupplierReference);
                var suggestionId = await InsertManualOrderRowAsync(connection, manualRequest, allRows, ct);
                results.Add(new ManualOrderBulkRowResult(rowNum, true, suggestionId, null));
            }
            catch (Exception ex)
            {
                // Deliberately broad — every row must be attempted regardless of what fails on an
                // earlier one, matching Node's own unconditional per-row try/catch.
                results.Add(new ManualOrderBulkRowResult(rowNum, false, null, ex.Message));
            }
        }

        var succeeded = results.Count(r => r.Success);
        return new ManualOrderBulkResult(body.Rows.Count, succeeded, body.Rows.Count - succeeded, results);
    }

    private static VendorMaterialForSuggestionRow? FindVendorMaterial(IReadOnlyList<VendorMaterialForSuggestionRow> allRows, string? vendorName, string? material)
    {
        var vn = (vendorName ?? "").Trim();
        var mat = (material ?? "").Trim();
        if (vn.Length == 0 || mat.Length == 0) return null;
        return allRows.FirstOrDefault(row =>
            string.Equals((row.VendorName ?? "").Trim(), vn, StringComparison.OrdinalIgnoreCase) &&
            string.Equals((row.Material ?? "").Trim(), mat, StringComparison.OrdinalIgnoreCase));
    }

    private static async Task<long> InsertManualOrderRowAsync(IDbConnection connection, ManualOrderRequest body, IReadOnlyList<VendorMaterialForSuggestionRow> allRows, CancellationToken ct)
    {
        if (body.OrderQty is not > 0) throw new NexusValidationException("orderQty must be greater than 0.");

        var r = (body.VendorMaterialId.HasValue ? allRows.FirstOrDefault(row => row.VendorMaterialId == body.VendorMaterialId.Value) : null)
            ?? throw new NexusNotFoundException("Vendor material not found.");

        var orderDate = body.OrderDate ?? DateTime.UtcNow;
        var leadTimeDays = r.LeadTimeDaysOverride ?? r.SapLeadTimeDays ?? r.DefaultLeadTimeDays ?? 0m;
        var transitTimeDays = r.TransitTimeDays ?? 0m;
        var isSpotPo = string.IsNullOrEmpty(r.ScheduleAgreement);

        AcceptPayload payload;
        if (body.DeliveryDate.HasValue)
        {
            // The operator already knows the real delivery date (the order's already been placed) —
            // use it as given rather than recomputing from the vendor's lead time.
            var deliveryDate = body.DeliveryDate.Value;
            payload = new AcceptPayload(r.VendorMaterialId, r.VendorId, r.Material, null, body.OrderQty.Value, orderDate,
                leadTimeDays, deliveryDate, transitTimeDays, ForecastMathHelper.AddWorkingDaysUtc(deliveryDate, -transitTimeDays), isSpotPo, body.Notes);
        }
        else
        {
            payload = BuildAcceptPayload(r.VendorMaterialId, r.VendorId, r.Material, null, body.OrderQty.Value, orderDate, leadTimeDays, transitTimeDays, isSpotPo, body.Notes, null);
        }

        var suggestionId = await InsertAcceptedOrderAsync(connection, payload, ct);

        // acceptOrderSuggestion always inserts as 'Accepted' — flip it on if the caller says this
        // is further along (already raised in SAP / already booked in / already arrived), and
        // persist PO number / supplier reference in the same call.
        var finalStatus = body.Status is "Ordered" or "Booked" or "Received" ? body.Status : "Accepted";
        if (finalStatus != "Accepted" || !string.IsNullOrEmpty(body.PoNumber) || !string.IsNullOrEmpty(body.SupplierReference))
        {
            await UpdateStatusInternalAsync(connection, suggestionId,
                new UpdateOrderSuggestionStatusRequest(finalStatus, body.PoNumber, null, body.Notes, body.SupplierReference, null, null, null), ct);
        }

        return suggestionId;
    }

    // ── Tracked Orders ─────────────────────────────────────────────────

    /// <summary>Everything except Cancelled, ordered by status stage then most-recent order first, so "needs attention" rows (still Accepted, not yet actually raised in SAP) surface at the top.</summary>
    internal static async Task<IReadOnlyList<OrderSuggestionTrackedRow>> ListTrackedAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<OrderSuggestionTrackedRow>(new CommandDefinition("""
            SELECT
              p.SuggestionId, p.VendorId, v.VendorName, v.SapVendorNumber, v.Currency, v.OrderMoqUom, v.Incoterms, p.VendorMaterialId, p.Material,
              t.MaterialText, t.Uom, p.Status, p.SuggestedQty, p.OrderQty, p.OrderDate,
              p.LeadTimeDaysUsed, p.DeliveryDate, p.TransitTimeDaysUsed, p.ReadyToCollectDate,
              p.IsSpotPo, p.PoNumber, p.PoItemNumber, p.Notes, p.SupplierReference,
              p.CreatedAtUtc, p.UpdatedAtUtc, p.ReceivedAtUtc,
              p.ShipmentId, s.ShipmentReference, s.Haulier, s.ModeOfTransport,
              s.TrackingNumber AS ShipmentTrackingNumber, s.ExpectedEta, s.ReceivedAtUtc AS ShipmentReceivedAtUtc,
              vm.ScheduleAgreement, vm.ScheduleAgreementItem
            FROM log.PurchaseOrderSuggestion p
            JOIN log.Vendor v ON v.VendorId = p.VendorId
            LEFT JOIN log.TurnsValClassSnapshot t ON t.Material = p.Material
            LEFT JOIN log.PurchaseOrderShipment s ON s.ShipmentId = p.ShipmentId
            LEFT JOIN log.VendorMaterial vm ON vm.VendorMaterialId = p.VendorMaterialId
            WHERE p.Status <> 'Cancelled'
            ORDER BY
              CASE p.Status WHEN 'Accepted' THEN 0 WHEN 'Ordered' THEN 1 WHEN 'Booked' THEN 2 WHEN 'Received' THEN 3 ELSE 4 END,
              p.OrderDate DESC
            """, cancellationToken: ct));
        return rows.AsList();
    }

    /// <summary>Every line on a given real SAP PO, ordered by PO item — backs "Recreate PO PDF" (regenerate-pdf, 8b.7). A narrower query than ListTrackedAsync's own (no shipment/schedule-agreement columns) — the unmatched OrderSuggestionTrackedRow properties are simply left at their default by Dapper, which is fine since regenerate-pdf never reads them.</summary>
    internal static async Task<IReadOnlyList<OrderSuggestionTrackedRow>> ListByPoNumberAsync(INexusOperationsDb db, string poNumber, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<OrderSuggestionTrackedRow>(new CommandDefinition("""
            SELECT
              p.SuggestionId, p.VendorId, v.VendorName, v.SapVendorNumber, v.Currency, v.OrderMoqUom, v.Incoterms, p.VendorMaterialId, p.Material,
              t.MaterialText, t.Uom, p.Status, p.SuggestedQty, p.OrderQty, p.OrderDate,
              p.LeadTimeDaysUsed, p.DeliveryDate, p.TransitTimeDaysUsed, p.ReadyToCollectDate,
              p.IsSpotPo, p.PoNumber, p.PoItemNumber, p.Notes, p.SupplierReference,
              p.CreatedAtUtc, p.UpdatedAtUtc, p.ReceivedAtUtc
            FROM log.PurchaseOrderSuggestion p
            JOIN log.Vendor v ON v.VendorId = p.VendorId
            LEFT JOIN log.TurnsValClassSnapshot t ON t.Material = p.Material
            WHERE p.PoNumber = @poNumber
            ORDER BY p.PoItemNumber
            """, new { poNumber }, cancellationToken: ct));
        return rows.AsList();
    }

    /// <summary>One PO per vendor's worth of Accepted, not-yet-ordered tracked orders — flips them straight to 'Ordered' using the material's own schedule agreement as the PO number, skipping the elevated real-SAP-PO-creation flow (8b.7) entirely for materials that already have one on file.</summary>
    internal static async Task<AssignScheduleAgreementResult> AssignScheduleAgreementAsync(INexusOperationsDb db, AssignScheduleAgreementRequest body, CancellationToken ct)
    {
        if (body.SuggestionIds is not { Count: > 0 }) throw new NexusValidationException("suggestionIds must be a non-empty array.");

        // Fresh from the DB, not trusted from whatever the client had on screen.
        var idSet = body.SuggestionIds.ToHashSet();
        var allTracked = await ListTrackedAsync(db, ct);
        var rows = allTracked.Where(r => idSet.Contains(r.SuggestionId)).ToList();

        if (rows.Count != body.SuggestionIds.Count)
            throw new NexusNotFoundException("One or more selected orders could not be found.");

        var alreadyOrdered = rows.Where(r => !string.IsNullOrEmpty(r.PoNumber) || r.Status != "Accepted").ToList();
        if (alreadyOrdered.Count > 0)
            throw new NexusValidationException($"{alreadyOrdered.Count} of the selected line(s) already have a PO number or aren't in Accepted status — refresh and try again.");

        var missingAgreement = rows.Where(r => string.IsNullOrEmpty(r.ScheduleAgreement)).ToList();
        if (missingAgreement.Count > 0)
            throw new NexusValidationException($"{string.Join(", ", missingAgreement.Select(r => r.Material))} — no schedule agreement on file in Vendor Master Data. Refresh and try again, or use Create PO in SAP instead.");

        using var connection = await db.CreateConnectionAsync(ct);
        foreach (var r in rows)
        {
            await UpdateStatusInternalAsync(connection, r.SuggestionId,
                new UpdateOrderSuggestionStatusRequest("Ordered", r.ScheduleAgreement, r.ScheduleAgreementItem, r.Notes, r.SupplierReference, null, null, null), ct);
        }

        return new AssignScheduleAgreementResult(rows.Select(r => r.SuggestionId).ToList());
    }

    /// <summary>Full-row update — the caller sends the complete current state (see UpdateOrderSuggestionStatusRequest's own comment).</summary>
    internal static async Task UpdateStatusAsync(INexusOperationsDb db, long suggestionId, UpdateOrderSuggestionStatusRequest body, CancellationToken ct)
    {
        if (body.Status is not ("Accepted" or "Ordered" or "Booked" or "Received" or "Cancelled"))
            throw new NexusValidationException("status must be one of Accepted, Ordered, Booked, Received, Cancelled.");
        if (body.OrderQty is not null && body.OrderQty <= 0)
            throw new NexusValidationException("orderQty must be greater than 0.");

        using var connection = await db.CreateConnectionAsync(ct);
        await UpdateStatusInternalAsync(connection, suggestionId, body, ct);
    }

    /// <summary>Locks a Tracked Orders row once it's Completed (Received/Booked) against status updates/delete — the only way back out is Undo Received on the order's shipment (8b.7). Also reused by InboundShipmentHelper.AssignShipmentAsync (8b.4), which links/unlinks a tracked order to a shipment.</summary>
    internal static async Task AssertOrderEditableAsync(IDbConnection connection, long suggestionId, CancellationToken ct)
    {
        var status = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "SELECT Status FROM log.PurchaseOrderSuggestion WHERE SuggestionId = @suggestionId", new { suggestionId }, cancellationToken: ct));
        if (status is null) throw new NexusNotFoundException("Tracked order not found.");
        if (status is "Received" or "Booked")
            throw new NexusConflictException("This order has already been received and is locked — use Undo Received on its Inbound Shipment to reverse it first.");
    }

    private static async Task UpdateStatusInternalAsync(IDbConnection connection, long suggestionId, UpdateOrderSuggestionStatusRequest body, CancellationToken ct)
    {
        await AssertOrderEditableAsync(connection, suggestionId, ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.PurchaseOrderSuggestion SET
              Status = @Status, PoNumber = @PoNumber, Notes = @Notes,
              SupplierReference = @SupplierReference,
              PoItemNumber = COALESCE(@PoItemNumber, PoItemNumber),
              OrderQty = COALESCE(@OrderQty, OrderQty),
              DeliveryDate = COALESCE(@DeliveryDate, DeliveryDate),
              ReadyToCollectDate = COALESCE(@ReadyToCollectDate, ReadyToCollectDate),
              UpdatedAtUtc = GETUTCDATE(),
              ReceivedAtUtc = CASE WHEN @Status = 'Received' THEN GETUTCDATE() ELSE ReceivedAtUtc END
            WHERE SuggestionId = @suggestionId
            """, new { suggestionId, body.Status, body.PoNumber, body.Notes, body.SupplierReference, body.PoItemNumber, body.OrderQty, body.DeliveryDate, body.ReadyToCollectDate }, cancellationToken: ct));
    }

    /// <summary>Narrow PO Item Number update, deliberately NOT covered by AssertOrderEditableAsync's completed-order lock — used by the Inbound Shipment detail's SAP GR retry control (8b.4) to retry a goods receipt that didn't post for lack of a PO item number, which needs to keep working on an already-Received line.</summary>
    internal static async Task UpdatePoItemAsync(INexusOperationsDb db, long suggestionId, UpdateOrderSuggestionPoItemRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.PurchaseOrderSuggestion SET PoItemNumber = @poItemNumber, UpdatedAtUtc = GETUTCDATE()
            WHERE SuggestionId = @suggestionId
            """, new { suggestionId, poItemNumber = body.PoItemNumber }, cancellationToken: ct));
    }

    /// <summary>Hard delete — distinct from Status='Cancelled' (which just hides the row while keeping it for audit). For genuine mistakes only; blocked once an order is Received/Booked.</summary>
    internal static async Task DeleteAsync(INexusOperationsDb db, long suggestionId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await AssertOrderEditableAsync(connection, suggestionId, ct);
        var deletedId = await connection.QuerySingleOrDefaultAsync<long?>(new CommandDefinition(
            "DELETE FROM log.PurchaseOrderSuggestion OUTPUT DELETED.SuggestionId WHERE SuggestionId = @suggestionId", new { suggestionId }, cancellationToken: ct));
        if (deletedId is null) throw new NexusNotFoundException("Tracked order not found.");
    }
}
