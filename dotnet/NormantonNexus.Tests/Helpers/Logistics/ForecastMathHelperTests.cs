using NormantonNexus.Helpers.Logistics;
using static NormantonNexus.Helpers.Logistics.ForecastMathHelper;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class ForecastMathHelperTests
{
    private static DateTime Utc(int y, int m, int d) => new(y, m, d, 0, 0, 0, DateTimeKind.Utc);

    // 13 entries, index 0 = the month containing `from` — flat 310/month (31 days => ~10/day) for
    // predictability, then zero for every following month so a forecast horizon test's tail is calm.
    private static List<decimal> FlatMonthly(decimal firstMonthQty, int months = 13)
    {
        var list = new List<decimal> { firstMonthQty };
        for (var i = 1; i < months; i++) list.Add(0m);
        return list;
    }

    [Fact]
    public void MakeDailyUsageFn_spreads_a_months_predicted_qty_evenly_across_its_days()
    {
        var from = Utc(2026, 1, 1); // January = 31 days
        var fn = MakeDailyUsageFn(FlatMonthly(310m), from);

        Assert.Equal(10m, fn(Utc(2026, 1, 15)));
        Assert.Equal(0m, fn(Utc(2026, 2, 1))); // next month's (zero) rate
    }

    [Fact]
    public void MakeDailyUsageFn_applies_a_matching_demand_adjustment_as_a_percentage()
    {
        var from = Utc(2026, 1, 1);
        var adjustments = new[] { new DemandAdjustmentWindow(Utc(2026, 1, 10), Utc(2026, 1, 20), 50m) };
        var fn = MakeDailyUsageFn(FlatMonthly(310m), from, adjustments);

        Assert.Equal(5m, fn(Utc(2026, 1, 15))); // inside the window: halved
        Assert.Equal(10m, fn(Utc(2026, 1, 5))); // outside the window: untouched
    }

    [Fact]
    public void MakeDailyUsageFn_treats_a_null_adjustment_bound_as_unbounded()
    {
        var from = Utc(2026, 1, 1);
        var adjustments = new[] { new DemandAdjustmentWindow(null, null, 0m) }; // unbounded, zeroes usage out entirely
        var fn = MakeDailyUsageFn(FlatMonthly(310m), from, adjustments);

        Assert.Equal(0m, fn(Utc(2026, 6, 1)));
    }

    [Fact]
    public void MakeIsoparDailyUsageFn_uses_the_weekend_rate_on_Saturday_and_Sunday()
    {
        var fn = MakeIsoparDailyUsageFn(weekdayRateLPerDay: 100m, weekendRateLPerDay: 20m);

        Assert.Equal(20m, fn(Utc(2026, 1, 3))); // Saturday
        Assert.Equal(20m, fn(Utc(2026, 1, 4))); // Sunday
        Assert.Equal(100m, fn(Utc(2026, 1, 5))); // Monday
    }

    [Fact]
    public void BuildWeeklyStockForecast_depletes_stock_week_by_week_at_the_flat_rate()
    {
        var today = Utc(2026, 1, 1);
        var result = BuildWeeklyStockForecast(currentStock: 1000m, predictedMonthly: FlatMonthly(310m), today: today);

        Assert.Equal("2026-01-01", result.AsOfDate);
        Assert.Equal(1000m, result.CurrentStock);
        Assert.Equal(7, result.BucketDays);
        Assert.True(result.Weeks.Count > 0);
        // First week: 7 days * 10/day = 70 usage, no incoming.
        Assert.Equal(70m, result.Weeks[0].WeeklyUsage);
        Assert.Equal(930m, result.Weeks[0].ExpectedStock);
        Assert.Empty(result.Weeks[0].Deliveries);
    }

    [Fact]
    public void BuildWeeklyStockForecast_credits_an_incoming_delivery_in_the_week_it_actually_lands()
    {
        var today = Utc(2026, 1, 1);
        var deliveries = new[] { new IncomingDelivery(Utc(2026, 1, 10), 500m, Id: 7, PoNumber: "PO123") };

        var result = BuildWeeklyStockForecast(1000m, FlatMonthly(310m), today, deliveries);

        // Week 1 (Jan 1-8): no delivery yet.
        Assert.Equal(0m, result.Weeks[0].IncomingQty);
        // Week 2 (Jan 8-15): the Jan 10 delivery lands here.
        Assert.Equal(500m, result.Weeks[1].IncomingQty);
        var delivery = Assert.Single(result.Weeks[1].Deliveries);
        Assert.Equal(7, delivery.Id);
        Assert.Equal("PO123", delivery.PoNumber);
        Assert.Equal(500m, delivery.Qty);
    }

    [Fact]
    public void BuildWeeklyStockForecast_with_bucketDays_1_produces_a_daily_series()
    {
        var today = Utc(2026, 1, 1);
        var result = BuildWeeklyStockForecast(1000m, FlatMonthly(310m), today, bucketDays: 1);

        Assert.Equal(1, result.BucketDays);
        Assert.Equal(10m, result.Weeks[0].WeeklyUsage); // one day's usage
        Assert.Equal(990m, result.Weeks[0].ExpectedStock);
    }

    [Fact]
    public void BuildWeeklyStockForecast_uses_the_override_daily_usage_function_when_given()
    {
        var today = Utc(2026, 1, 1);
        var isoparFn = MakeIsoparDailyUsageFn(100m, 20m);

        var result = BuildWeeklyStockForecast(10000m, FlatMonthly(0m), today, dailyUsageFnOverride: isoparFn, bucketDays: 1);

        // Jan 1 2026 is a Thursday — weekday rate.
        Assert.Equal(100m, result.Weeks[0].WeeklyUsage);
    }

    [Fact]
    public void MergeWeeklyForecasts_sums_multiple_materials_bucket_by_bucket()
    {
        var today = Utc(2026, 1, 1);
        var a = BuildWeeklyStockForecast(500m, FlatMonthly(310m), today);
        var b = BuildWeeklyStockForecast(300m, FlatMonthly(140m), today);

        var merged = MergeWeeklyForecasts([a, b]);

        Assert.Equal(800m, merged.CurrentStock);
        Assert.Equal(a.Weeks[0].WeeklyUsage + b.Weeks[0].WeeklyUsage, merged.Weeks[0].WeeklyUsage);
        Assert.Equal(a.Weeks[0].ExpectedStock + b.Weeks[0].ExpectedStock, merged.Weeks[0].ExpectedStock);
    }

    [Fact]
    public void MergeWeeklyForecasts_tags_each_delivery_with_its_material_only_when_merging_more_than_one()
    {
        var today = Utc(2026, 1, 1);
        var deliveryA = new[] { new IncomingDelivery(Utc(2026, 1, 2), 50m) };
        var a = BuildWeeklyStockForecast(500m, FlatMonthly(310m), today, deliveryA);
        var b = BuildWeeklyStockForecast(300m, FlatMonthly(140m), today);

        var singleMerge = MergeWeeklyForecasts([a]);
        Assert.Null(singleMerge.Weeks[0].Deliveries[0].Material);

        var multiMerge = MergeWeeklyForecasts([a, b], materials: ["MAT1", "MAT2"]);
        Assert.Equal("MAT1", multiMerge.Weeks[0].Deliveries[0].Material);
    }

    [Fact]
    public void MergeWeeklyForecasts_returns_an_empty_result_for_no_forecasts()
    {
        var result = MergeWeeklyForecasts([]);
        Assert.Null(result.AsOfDate);
        Assert.Equal(0m, result.CurrentStock);
        Assert.Empty(result.Weeks);
    }

    [Theory]
    [InlineData(1, DayOfWeek.Friday)]
    [InlineData(-1, DayOfWeek.Wednesday)]
    public void AddWorkingDaysUtc_skips_weekends(int days, DayOfWeek expectedDow)
    {
        var thursday = Utc(2026, 1, 1); // 2026-01-01 is a Thursday
        var result = AddWorkingDaysUtc(thursday, days);
        Assert.Equal(expectedDow, result.DayOfWeek);
    }

    [Fact]
    public void AddWorkingDaysUtc_steps_over_a_weekend()
    {
        var friday = Utc(2026, 1, 2);
        var result = AddWorkingDaysUtc(friday, 1);
        Assert.Equal(Utc(2026, 1, 5), result); // Monday, not Saturday
    }

    [Fact]
    public void AddWorkingDaysUtc_rounds_a_fractional_day_count_to_the_nearest_whole_day()
    {
        var thursday = Utc(2026, 1, 1);
        var result = AddWorkingDaysUtc(thursday, 2.5m);
        Assert.Equal(Utc(2026, 1, 6), result); // rounds to 3 working days -> Tue
    }

    [Fact]
    public void DemandOverDays_sums_daily_usage_across_the_given_window()
    {
        var from = Utc(2026, 1, 1);
        var total = DemandOverDays(FlatMonthly(310m), from, 10);
        Assert.Equal(100m, total); // 10 days * 10/day
    }

    [Fact]
    public void FindStockBelowThresholdDate_returns_null_when_never_breached()
    {
        var today = Utc(2026, 1, 1);
        var forecast = BuildWeeklyStockForecast(1_000_000m, FlatMonthly(310m), today);

        Assert.Null(FindStockBelowThresholdDate(forecast, today, threshold: 0m));
    }

    [Fact]
    public void FindStockBelowThresholdDate_interpolates_within_the_breaching_week()
    {
        var today = Utc(2026, 1, 1);
        // 70 units/week usage, starting stock 100 -> breaches below threshold 50 partway through week 1.
        var forecast = BuildWeeklyStockForecast(100m, FlatMonthly(310m), today);

        var breachDate = FindStockBelowThresholdDate(forecast, today, threshold: 50m);

        Assert.NotNull(breachDate);
        Assert.True(breachDate >= today && breachDate <= today.AddDays(7));
    }

    [Fact]
    public void FindStockBelowThresholdDate_returns_asOfDate_itself_when_already_at_or_below_threshold()
    {
        var today = Utc(2026, 1, 1);
        var forecast = BuildWeeklyStockForecast(10m, FlatMonthly(310m), today);

        var breachDate = FindStockBelowThresholdDate(forecast, today, threshold: 1000m);

        Assert.Equal(today, breachDate);
    }
}
