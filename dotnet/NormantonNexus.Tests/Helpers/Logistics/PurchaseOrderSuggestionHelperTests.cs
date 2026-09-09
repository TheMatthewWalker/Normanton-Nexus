using Moq;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class PurchaseOrderSuggestionHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    private static DateTime Utc(int y, int m, int d) => new(y, m, d, 0, 0, 0, DateTimeKind.Utc);

    // ── EnforceMaterialQty ───────────────────────────────────────────────

    [Fact]
    public void EnforceMaterialQty_snaps_to_the_nearest_lot_multiple()
    {
        Assert.Equal(1000m, PurchaseOrderSuggestionHelper.EnforceMaterialQty(950m, 500m, null));
        Assert.Equal(1500m, PurchaseOrderSuggestionHelper.EnforceMaterialQty(1300m, 500m, null));
    }

    [Fact]
    public void EnforceMaterialQty_never_snaps_a_genuinely_entered_qty_all_the_way_to_zero()
    {
        Assert.Equal(500m, PurchaseOrderSuggestionHelper.EnforceMaterialQty(100m, 500m, null));
    }

    [Fact]
    public void EnforceMaterialQty_clamps_to_the_largest_whole_lot_under_the_cap()
    {
        // 2600 rounds to 2500 (5 lots of 500), already under the 2700 cap.
        Assert.Equal(2500m, PurchaseOrderSuggestionHelper.EnforceMaterialQty(2600m, 500m, 2700m));
        // 2900 rounds to 3000 (6 lots), over the 2700 cap -> clamp down to 5 lots = 2500.
        Assert.Equal(2500m, PurchaseOrderSuggestionHelper.EnforceMaterialQty(2900m, 500m, 2700m));
    }

    [Fact]
    public void EnforceMaterialQty_clamps_straight_to_the_cap_when_there_is_no_lot_size()
    {
        Assert.Equal(1000m, PurchaseOrderSuggestionHelper.EnforceMaterialQty(1500m, null, 1000m));
    }

    [Fact]
    public void EnforceMaterialQty_passes_through_with_3_decimal_rounding_when_no_constraints()
    {
        Assert.Equal(123.457m, PurchaseOrderSuggestionHelper.EnforceMaterialQty(123.4567m, null, null));
    }

    // ── ValidateVendorCombinedQty ────────────────────────────────────────

    [Fact]
    public void ValidateVendorCombinedQty_requires_an_exact_total_for_an_exact_quantity_vendor()
    {
        var error = PurchaseOrderSuggestionHelper.ValidateVendorCombinedQty(19000m, 20000m, 20000m);
        Assert.NotNull(error);
        Assert.Contains("exact combined order of 20,000", error);
    }

    [Fact]
    public void ValidateVendorCombinedQty_allows_the_exact_total_for_an_exact_quantity_vendor()
    {
        Assert.Null(PurchaseOrderSuggestionHelper.ValidateVendorCombinedQty(20000m, 20000m, 20000m));
    }

    [Fact]
    public void ValidateVendorCombinedQty_rejects_a_total_below_the_moq()
    {
        var error = PurchaseOrderSuggestionHelper.ValidateVendorCombinedQty(400m, 500m, null);
        Assert.NotNull(error);
        Assert.Contains("at least 500", error);
    }

    [Fact]
    public void ValidateVendorCombinedQty_rejects_a_total_above_the_max()
    {
        var error = PurchaseOrderSuggestionHelper.ValidateVendorCombinedQty(1200m, null, 1000m);
        Assert.NotNull(error);
        Assert.Contains("cannot exceed 1,000", error);
    }

    [Fact]
    public void ValidateVendorCombinedQty_returns_null_when_within_bounds_or_unconstrained()
    {
        Assert.Null(PurchaseOrderSuggestionHelper.ValidateVendorCombinedQty(750m, 500m, 1000m));
        Assert.Null(PurchaseOrderSuggestionHelper.ValidateVendorCombinedQty(750m, null, null));
    }

    // ── BuildAcceptPayload ───────────────────────────────────────────────

    [Fact]
    public void BuildAcceptPayload_derives_delivery_date_from_working_days_lead_time()
    {
        var orderDate = Utc(2026, 1, 2); // Friday
        var payload = PurchaseOrderSuggestionHelper.BuildAcceptPayload(1, 1, "MAT1", null, 100m, orderDate, leadTimeDays: 1m, transitTimeDays: null, isSpotPo: true, notes: null, deliveryDateOverride: null);

        Assert.Equal(Utc(2026, 1, 5), payload.DeliveryDate); // skips the weekend
    }

    [Fact]
    public void BuildAcceptPayload_prefers_an_explicit_delivery_date_override()
    {
        var orderDate = Utc(2026, 1, 2);
        var overrideDate = Utc(2026, 2, 1);
        var payload = PurchaseOrderSuggestionHelper.BuildAcceptPayload(1, 1, "MAT1", null, 100m, orderDate, leadTimeDays: 1m, transitTimeDays: null, isSpotPo: true, notes: null, deliveryDateOverride: overrideDate);

        Assert.Equal(overrideDate, payload.DeliveryDate);
    }

    [Fact]
    public void BuildAcceptPayload_computes_ready_to_collect_date_from_transit_time()
    {
        var orderDate = Utc(2026, 1, 1); // Thursday
        var payload = PurchaseOrderSuggestionHelper.BuildAcceptPayload(1, 1, "MAT1", null, 100m, orderDate, leadTimeDays: 0m, transitTimeDays: 2m, isSpotPo: false, notes: "n", deliveryDateOverride: null);

        // deliveryDate == orderDate (0 lead time), ready-to-collect is 2 working days earlier.
        Assert.True(payload.ReadyToCollectDate < payload.DeliveryDate);
        Assert.Equal("n", payload.Notes);
    }

    // ── GroupSuggestionsByVendor ─────────────────────────────────────────

    private static OrderSuggestion Suggestion(long vendorId, string vendorName, string material, decimal suggestedQty, string orderByDate, decimal? orderMoqQty = null, decimal? orderMaxQty = null, string? orderMoqUom = null) =>
        new(1, vendorId, vendorName, material, null, "KG", null, 0m, 0m, 0m, null, 0m, 0m, orderByDate, "Overdue", true, suggestedQty,
            null, null, orderMoqQty, orderMaxQty, orderMoqUom, null, true, null, null);

    [Fact]
    public void GroupSuggestionsByVendor_sums_suggested_quantities_per_vendor()
    {
        var suggestions = new[]
        {
            Suggestion(1, "Acme", "MAT1", 100m, "2026-01-05"),
            Suggestion(1, "Acme", "MAT2", 50m, "2026-01-10"),
        };

        var groups = PurchaseOrderSuggestionHelper.GroupSuggestionsByVendor(suggestions);

        var group = Assert.Single(groups);
        Assert.Equal(150m, group.CombinedQty);
        Assert.Equal(2, group.Materials.Count);
    }

    [Fact]
    public void GroupSuggestionsByVendor_flags_moq_shortfall_when_combined_total_is_under_the_vendor_moq()
    {
        var suggestions = new[] { Suggestion(1, "Acme", "MAT1", 300m, "2026-01-05", orderMoqQty: 500m) };

        var group = Assert.Single(PurchaseOrderSuggestionHelper.GroupSuggestionsByVendor(suggestions));

        Assert.False(group.MoqMet);
        Assert.Equal(200m, group.MoqShortfall);
    }

    [Fact]
    public void GroupSuggestionsByVendor_identifies_an_exact_quantity_vendor()
    {
        var suggestions = new[] { Suggestion(1, "Raaj Ratna", "MAT1", 20000m, "2026-01-05", orderMoqQty: 20000m, orderMaxQty: 20000m) };

        var group = Assert.Single(PurchaseOrderSuggestionHelper.GroupSuggestionsByVendor(suggestions));

        Assert.True(group.IsExactQty);
        Assert.True(group.MoqMet);
    }

    [Fact]
    public void GroupSuggestionsByVendor_sorts_by_earliest_orderByDate_across_vendors()
    {
        var suggestions = new[]
        {
            Suggestion(1, "Later Vendor", "MAT1", 100m, "2026-03-01"),
            Suggestion(2, "Earlier Vendor", "MAT2", 100m, "2026-01-01"),
        };

        var groups = PurchaseOrderSuggestionHelper.GroupSuggestionsByVendor(suggestions);

        Assert.Equal("Earlier Vendor", groups[0].VendorName);
        Assert.Equal("Later Vendor", groups[1].VendorName);
    }

    // ── BuildSuggestionForRow ────────────────────────────────────────────

    private static VendorMaterialForSuggestionRow Row(
        string material = "MAT1", decimal? stockQty = 1000m, decimal? consignmentQty = null,
        decimal? minSafetyStockQty = 0m, decimal? leadTimeDaysOverride = 5m, decimal? materialMoqQty = null, decimal? materialMaxQty = null,
        string? orderMoqUom = null, string? uom = "KG", string? scheduleAgreement = null, decimal predictedMonthly = 300m) =>
        new(1, 1, material, materialMoqQty, materialMaxQty, leadTimeDaysOverride, minSafetyStockQty, scheduleAgreement,
            "Acme Ltd", null, null, null, orderMoqUom, null, null,
            "Material One", uom, "001", stockQty, consignmentQty, null, null,
            predictedMonthly, predictedMonthly, predictedMonthly, predictedMonthly, predictedMonthly, predictedMonthly,
            predictedMonthly, predictedMonthly, predictedMonthly, predictedMonthly, predictedMonthly, predictedMonthly, predictedMonthly);

    private static readonly Dictionary<string, List<OpenIncomingOrderRow>> NoIncoming = [];
    private static readonly Dictionary<string, List<ForecastMathHelper.DemandAdjustmentWindow>> NoAdjustments = [];

    [Fact]
    public void BuildSuggestionForRow_returns_null_when_there_is_no_SAP_snapshot_at_all()
    {
        var row = Row(stockQty: null, consignmentQty: null);
        var today = Utc(2026, 1, 1);

        var result = PurchaseOrderSuggestionHelper.BuildSuggestionForRow(row, NoIncoming, today, today, today.AddDays(14), NoAdjustments, null);

        Assert.Null(result);
    }

    [Fact]
    public void BuildSuggestionForRow_flags_NotDue_when_stock_never_breaches_the_safety_floor()
    {
        var row = Row(stockQty: 1_000_000m, minSafetyStockQty: 0m, predictedMonthly: 31m); // trivial usage
        var today = Utc(2026, 1, 1);

        var result = PurchaseOrderSuggestionHelper.BuildSuggestionForRow(row, NoIncoming, today, today, today.AddDays(14), NoAdjustments, null)!;

        Assert.Equal("NotDue", result.Urgency);
        Assert.False(result.DueNow);
        Assert.Equal(0m, result.SuggestedQty);
    }

    [Fact]
    public void BuildSuggestionForRow_flags_Overdue_when_the_breach_already_happened()
    {
        // Very high usage against low stock and a 0-day lead time -> breach lands in the past
        // relative to the order-by calc (orderByDate == breachDate here), so this is at least DueSoon;
        // to force genuinely Overdue we need orderByDate < asOfDate, which happens with a long lead time
        // that pushes the order-by date behind today even though the breach itself is soon.
        var row = Row(stockQty: 50m, minSafetyStockQty: 0m, leadTimeDaysOverride: 60m, predictedMonthly: 310m);
        var today = Utc(2026, 1, 1);

        var result = PurchaseOrderSuggestionHelper.BuildSuggestionForRow(row, NoIncoming, today, today, today.AddDays(14), NoAdjustments, null)!;

        Assert.Equal("Overdue", result.Urgency);
        Assert.True(result.DueNow);
    }

    [Fact]
    public void BuildSuggestionForRow_flags_DueSoon_within_the_review_horizon()
    {
        // ~10/day usage against 100 on hand -> breaches around day 10, well within the 14-day horizon.
        var row = Row(stockQty: 100m, minSafetyStockQty: 0m, leadTimeDaysOverride: 1m, predictedMonthly: 310m);
        var today = Utc(2026, 1, 1);

        var result = PurchaseOrderSuggestionHelper.BuildSuggestionForRow(row, NoIncoming, today, today, today.AddDays(14), NoAdjustments, null)!;

        Assert.Equal("DueSoon", result.Urgency);
        Assert.True(result.DueNow);
        Assert.True(result.SuggestedQty > 0);
    }

    [Fact]
    public void BuildSuggestionForRow_rounds_a_dueNow_suggestion_up_to_the_material_lot_size()
    {
        var row = Row(stockQty: 100m, minSafetyStockQty: 0m, leadTimeDaysOverride: 1m, materialMoqQty: 1000m, predictedMonthly: 310m);
        var today = Utc(2026, 1, 1);

        var result = PurchaseOrderSuggestionHelper.BuildSuggestionForRow(row, NoIncoming, today, today, today.AddDays(14), NoAdjustments, null)!;

        Assert.Equal(0m, result.SuggestedQty % 1000m);
        Assert.True(result.SuggestedQty > 0);
    }

    [Fact]
    public void BuildSuggestionForRow_credits_consignment_stock_alongside_dock_stock()
    {
        var row = Row(stockQty: 500m, consignmentQty: 500m, minSafetyStockQty: 0m, predictedMonthly: 31m);
        var today = Utc(2026, 1, 1);

        var result = PurchaseOrderSuggestionHelper.BuildSuggestionForRow(row, NoIncoming, today, today, today.AddDays(14), NoAdjustments, null)!;

        Assert.Equal(1000m, result.CurrentStock);
    }

    [Fact]
    public void BuildSuggestionForRow_uses_the_Isopar_meter_reading_in_place_of_SAP_stock_when_present()
    {
        var row = Row(material: IsoparPeriodHelper.IsoparMaterial, stockQty: 999999m, minSafetyStockQty: 0m);
        var reading = new IsoparReadingRow(1, Utc(2026, 1, 1), 500m, null, null, Utc(2026, 1, 1), Utc(2026, 1, 1));
        var rate = new IsoparPlanningRateRow(1, 100m, 20m, null, "Manual", null, null, Utc(2026, 1, 1));
        var context = new IsoparForecastContext(reading, rate);
        var today = Utc(2026, 1, 1);

        var result = PurchaseOrderSuggestionHelper.BuildSuggestionForRow(row, NoIncoming, today, today, today.AddDays(14), NoAdjustments, context)!;

        Assert.NotNull(result.IsoparMeterReading);
        Assert.True(result.IsoparMeterReading!.UsingMeterReading);
        Assert.Equal("2026-01-01", result.IsoparMeterReading.ReadingDate);
    }

    [Fact]
    public void BuildSuggestionForRow_flags_a_fallback_warning_for_Isopar_with_no_reading_yet()
    {
        var row = Row(material: IsoparPeriodHelper.IsoparMaterial, stockQty: 500m, minSafetyStockQty: 0m);
        var today = Utc(2026, 1, 1);

        var result = PurchaseOrderSuggestionHelper.BuildSuggestionForRow(row, NoIncoming, today, today, today.AddDays(14), NoAdjustments, null)!;

        Assert.NotNull(result.IsoparMeterReading);
        Assert.False(result.IsoparMeterReading!.UsingMeterReading);
        Assert.NotNull(result.IsoparMeterReading.FallbackWarning);
    }

    [Fact]
    public void BuildSuggestionForRow_treats_a_missing_ScheduleAgreement_as_a_spot_PO()
    {
        var row = Row(scheduleAgreement: null);
        var today = Utc(2026, 1, 1);
        var result = PurchaseOrderSuggestionHelper.BuildSuggestionForRow(row, NoIncoming, today, today, today.AddDays(14), NoAdjustments, null)!;
        Assert.True(result.IsSpotPo);

        var rowWithAgreement = Row(scheduleAgreement: "4500001234");
        var resultWithAgreement = PurchaseOrderSuggestionHelper.BuildSuggestionForRow(rowWithAgreement, NoIncoming, today, today, today.AddDays(14), NoAdjustments, null)!;
        Assert.False(resultWithAgreement.IsSpotPo);
    }

    // ── Pre-connection validation guards ─────────────────────────────────

    [Fact]
    public async Task AcceptAsync_rejects_missing_required_fields_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = new AcceptOrderSuggestionRequest(null, null, null, null, null, null, null, null, null, null, null);

        await Assert.ThrowsAsync<NexusValidationException>(() => PurchaseOrderSuggestionHelper.AcceptAsync(db.Object, body, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task AcceptBatchAsync_rejects_a_missing_vendorId_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = new AcceptOrderSuggestionBatchRequest(null, null, [new AcceptBatchItem(1, "MAT1", null, 100m, null, null, null, null, null)]);

        await Assert.ThrowsAsync<NexusValidationException>(() => PurchaseOrderSuggestionHelper.AcceptBatchAsync(db.Object, body, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task AcceptBatchAsync_rejects_a_batch_with_no_valid_items_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = new AcceptOrderSuggestionBatchRequest(1, null, [new AcceptBatchItem(null, null, null, null, null, null, null, null, null)]);

        await Assert.ThrowsAsync<NexusValidationException>(() => PurchaseOrderSuggestionHelper.AcceptBatchAsync(db.Object, body, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task ManualAsync_rejects_a_missing_vendorMaterialId_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = new ManualOrderRequest(null, 100m, null, null, null, null, null, null);

        await Assert.ThrowsAsync<NexusValidationException>(() => PurchaseOrderSuggestionHelper.ManualAsync(db.Object, body, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task ManualBulkAsync_rejects_an_empty_rows_array_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = new ManualOrderBulkRequest([]);

        await Assert.ThrowsAsync<NexusValidationException>(() => PurchaseOrderSuggestionHelper.ManualBulkAsync(db.Object, body, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task PreviewAsync_rejects_an_empty_items_array_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = new OrderSuggestionPreviewRequest(Utc(2026, 1, 1), []);

        await Assert.ThrowsAsync<NexusValidationException>(() => PurchaseOrderSuggestionHelper.PreviewAsync(db.Object, body, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task PreviewAsync_rejects_a_missing_deliveryDate_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = new OrderSuggestionPreviewRequest(null, [new OrderSuggestionPreviewItem("MAT1", 100m)]);

        await Assert.ThrowsAsync<NexusValidationException>(() => PurchaseOrderSuggestionHelper.PreviewAsync(db.Object, body, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("Unknown")]
    public async Task UpdateStatusAsync_rejects_an_invalid_status_without_opening_a_connection(string? status)
    {
        var db = UnreachableDb();
        var body = new UpdateOrderSuggestionStatusRequest(status, null, null, null, null, null, null, null);

        await Assert.ThrowsAsync<NexusValidationException>(() => PurchaseOrderSuggestionHelper.UpdateStatusAsync(db.Object, 1, body, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task UpdateStatusAsync_rejects_a_non_positive_orderQty_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = new UpdateOrderSuggestionStatusRequest("Accepted", null, null, null, null, 0m, null, null);

        await Assert.ThrowsAsync<NexusValidationException>(() => PurchaseOrderSuggestionHelper.UpdateStatusAsync(db.Object, 1, body, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }
}
