using Moq;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class IsoparHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    private static DateTime Utc(int y, int m, int d) => new(y, m, d, 0, 0, 0, DateTimeKind.Utc);

    private static IsoparReadingRow Reading(DateTime date, decimal qty) => new(1, date, qty, null, null, date, date);

    // ── Pre-connection validation guards ────────────────────────────────

    [Fact]
    public async Task CreateReadingAsync_rejects_a_missing_readingDate_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            IsoparHelper.CreateReadingAsync(db.Object, new CreateIsoparReadingRequest(null, 100m, null), "tester", CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(-1d)]
    public async Task CreateReadingAsync_rejects_a_missing_or_negative_readingQty_without_opening_a_connection(double? readingQty)
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            IsoparHelper.CreateReadingAsync(db.Object, new CreateIsoparReadingRequest(Utc(2026, 1, 1), (decimal?)readingQty, null), "tester", CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task UpdateReadingAsync_rejects_a_negative_readingQty_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            IsoparHelper.UpdateReadingAsync(db.Object, 1, new UpdateIsoparReadingRequest(-5m, null), CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task UpdatePlanningRateAsync_rejects_a_negative_weekdayRate_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            IsoparHelper.UpdatePlanningRateAsync(db.Object, new UpdateIsoparPlanningRateRequest(-1m, null, null, null, null), "tester", CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task UpdatePlanningRateAsync_rejects_a_negative_maxStockCapacityQty_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            IsoparHelper.UpdatePlanningRateAsync(db.Object, new UpdateIsoparPlanningRateRequest(null, null, -1m, null, null), "tester", CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    // ── ComputePlanningRateRecommendation (pure) ────────────────────────

    [Fact]
    public void ComputePlanningRateRecommendation_only_counts_strictly_consecutive_1_day_apart_pairs()
    {
        var readings = new[]
        {
            Reading(Utc(2026, 1, 1), 1000m),
            Reading(Utc(2026, 1, 2), 900m),  // consecutive: consumed 100
            Reading(Utc(2026, 1, 5), 500m),  // gap of 3 days: skipped
        };

        var result = IsoparHelper.ComputePlanningRateRecommendation(null, readings);

        Assert.Equal(1, result.Actual.SampleIntervals);
    }

    [Fact]
    public void ComputePlanningRateRecommendation_buckets_by_weekday_vs_weekend()
    {
        // 2026-01-03 is a Saturday, 2026-01-04 a Sunday.
        var readings = new[]
        {
            Reading(Utc(2026, 1, 3), 1000m),
            Reading(Utc(2026, 1, 4), 900m), // weekend interval: consumed 100
        };

        var result = IsoparHelper.ComputePlanningRateRecommendation(null, readings);

        Assert.Equal(100m, result.Actual.WeekendAvgLPerDay);
        Assert.Null(result.Actual.WeekdayAvgLPerDay);
    }

    [Fact]
    public void ComputePlanningRateRecommendation_returns_no_recommendation_with_fewer_than_5_sample_intervals()
    {
        var readings = Enumerable.Range(0, 3).Select(i => Reading(Utc(2026, 1, 1).AddDays(i), 1000m - i * 100)).ToArray();
        var current = new IsoparPlanningRateRow(1, 50m, 20m, null, "Manual", null, null, Utc(2026, 1, 1));

        var result = IsoparHelper.ComputePlanningRateRecommendation(current, readings);

        Assert.Null(result.Recommendation);
    }

    [Fact]
    public void ComputePlanningRateRecommendation_recommends_when_actual_differs_from_current_by_more_than_5_percent()
    {
        // 6 consecutive weekday readings, each consuming 100/day (weekday rate) — 5 sample intervals.
        var readings = Enumerable.Range(0, 6).Select(i => Reading(Utc(2026, 1, 5).AddDays(i), 1000m - i * 100)).ToArray(); // 2026-01-05 is a Monday
        var current = new IsoparPlanningRateRow(1, 50m, 20m, null, "Manual", null, null, Utc(2026, 1, 1));

        var result = IsoparHelper.ComputePlanningRateRecommendation(current, readings);

        Assert.NotNull(result.Recommendation);
        Assert.Equal(100m, result.Recommendation!.WeekdayRateLPerDay);
    }

    [Fact]
    public void ComputePlanningRateRecommendation_gives_no_recommendation_when_within_5_percent_of_current()
    {
        // 6 consecutive days from Monday 2026-01-05 through Saturday 2026-01-10, each consuming
        // 100/day flat — both the weekday and weekend actual averages come out to 100.
        var readings = Enumerable.Range(0, 6).Select(i => Reading(Utc(2026, 1, 5).AddDays(i), 1000m - i * 100)).ToArray();
        var current = new IsoparPlanningRateRow(1, 100m, 100m, null, "Manual", null, null, Utc(2026, 1, 1)); // already matches actual exactly

        var result = IsoparHelper.ComputePlanningRateRecommendation(current, readings);

        Assert.Null(result.Recommendation);
    }

    // ── ComputeStockRisk (pure) ──────────────────────────────────────────

    [Fact]
    public void ComputeStockRisk_returns_null_when_no_reading_or_rate_configured()
    {
        Assert.Null(IsoparHelper.ComputeStockRisk(null, null, [], Utc(2026, 1, 1)));
    }

    [Fact]
    public void ComputeStockRisk_returns_null_when_stock_is_healthy_and_within_capacity()
    {
        var reading = Reading(Utc(2026, 1, 1), 10000m);
        var rate = new IsoparPlanningRateRow(1, 100m, 20m, 50000m, "Manual", null, null, Utc(2026, 1, 1));

        var result = IsoparHelper.ComputeStockRisk(reading, rate, [], Utc(2026, 1, 1));

        Assert.Null(result);
    }

    [Fact]
    public void ComputeStockRisk_flags_an_immediate_stockout_when_stock_is_already_at_or_below_zero()
    {
        var reading = Reading(Utc(2026, 1, 1), 0m);
        var rate = new IsoparPlanningRateRow(1, 100m, 20m, null, "Manual", null, null, Utc(2026, 1, 1));

        var result = IsoparHelper.ComputeStockRisk(reading, rate, [], Utc(2026, 1, 1));

        Assert.NotNull(result);
        Assert.Equal("2026-01-01", result!.StockoutDate);
    }

    [Fact]
    public void ComputeStockRisk_projects_a_future_stockout_within_the_review_window()
    {
        var reading = Reading(Utc(2026, 1, 1), 500m); // depletes at 100/day weekday -> 0 around day 5
        var rate = new IsoparPlanningRateRow(1, 100m, 100m, null, "Manual", null, null, Utc(2026, 1, 1));

        var result = IsoparHelper.ComputeStockRisk(reading, rate, [], Utc(2026, 1, 1));

        Assert.NotNull(result);
        Assert.NotNull(result!.StockoutDate);
    }

    [Fact]
    public void ComputeStockRisk_flags_an_immediate_overcapacity_when_stock_already_exceeds_the_cap()
    {
        var reading = Reading(Utc(2026, 1, 1), 60000m);
        var rate = new IsoparPlanningRateRow(1, 100m, 20m, 50000m, "Manual", null, null, Utc(2026, 1, 1));

        var result = IsoparHelper.ComputeStockRisk(reading, rate, [], Utc(2026, 1, 1));

        Assert.NotNull(result);
        Assert.Equal("2026-01-01", result!.OverCapacityDate);
        Assert.Null(result.StockoutDate);
    }

    [Fact]
    public void ComputeStockRisk_extends_the_review_window_to_cover_a_late_pending_delivery()
    {
        // No usage at all (weekend-only test day range irrelevant), but a huge delivery lands well
        // past the default 14-day review window and would overflow the tank — still must be caught.
        var reading = Reading(Utc(2026, 1, 1), 100m);
        var rate = new IsoparPlanningRateRow(1, 0m, 0m, 1000m, "Manual", null, null, Utc(2026, 1, 1));
        var incoming = new[] { new OpenIncomingOrderRow(1, IsoparPeriodHelper.IsoparMaterial, 5000m, Utc(2026, 3, 1), "Accepted", "PO1") };

        var result = IsoparHelper.ComputeStockRisk(reading, rate, incoming, Utc(2026, 1, 1));

        Assert.NotNull(result);
        Assert.NotNull(result!.OverCapacityDate);
    }
}
