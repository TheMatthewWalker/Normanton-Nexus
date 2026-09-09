using NormantonNexus.Helpers.Logistics;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class PredictedUsageHelperTests
{
    [Fact]
    public void ComputePredictedUsage_returns_all_zero_for_a_wrong_length_history()
    {
        var result = PredictedUsageHelper.ComputePredictedUsage(new decimal[10]);

        Assert.Equal(13, result.Length);
        Assert.All(result, v => Assert.Equal(0m, v));
    }

    [Fact]
    public void ComputePredictedUsage_returns_all_zero_for_a_null_history()
    {
        var result = PredictedUsageHelper.ComputePredictedUsage(null);

        Assert.All(result, v => Assert.Equal(0m, v));
    }

    [Fact]
    public void ComputePredictedUsage_returns_all_zero_when_overall_average_is_zero()
    {
        var result = PredictedUsageHelper.ComputePredictedUsage(new decimal[36]);

        Assert.All(result, v => Assert.Equal(0m, v));
    }

    [Fact]
    public void ComputePredictedUsage_a_flat_constant_history_predicts_the_same_constant_every_month()
    {
        var history = Enumerable.Repeat(100m, 36).ToArray();

        var result = PredictedUsageHelper.ComputePredictedUsage(history);

        Assert.All(result, v => Assert.Equal(100m, v));
    }

    [Fact]
    public void ComputePredictedUsage_never_returns_a_negative_value()
    {
        // A trailing-12-month average that's negative-leaning shouldn't happen with real
        // consumption data (always >= 0), but the Math.Max(0, ...) floor is still asserted here
        // directly against a seasonal index that would otherwise go negative.
        var history = new decimal[36];
        for (var i = 0; i < 36; i++) history[i] = i < 24 ? 0m : 10m; // low overall average, higher recent level

        var result = PredictedUsageHelper.ComputePredictedUsage(history);

        Assert.All(result, v => Assert.True(v >= 0m));
    }

    [Fact]
    public void ComputePredictedUsage_clamps_the_seasonal_index_at_4x_for_a_near_zero_overall_average()
    {
        // Index 35 (current month) is a huge spike against an otherwise-near-zero 36-month
        // history — without the MAX_SEASONAL_INDEX clamp this would blow baseLevel up by a
        // much larger multiple than 4x.
        var history = new decimal[36];
        history[35] = 100000m;
        // index 35-12=23 must equal history[35] to be picked up by k=0's weighted seasonal value
        history[23] = 100000m;

        var result = PredictedUsageHelper.ComputePredictedUsage(history);

        // baseLevel = average of last 12 (indices 24..35) = 100000/12; seasonalIndex capped at 4
        var expectedBaseLevel = 100000m / 12m;
        Assert.True(result[0] <= expectedBaseLevel * 4m + 0.01m);
    }

    [Fact]
    public void ComputePredictedUsage_weights_the_most_recent_year_3x_over_two_years_back()
    {
        // k=0 (current month, index 35): seasonal observations come from index 23 (1yr back,
        // weight 3) and index 11 (2yr back, weight 2) — both outside the last-12-months window
        // (indices 24..35), so baseLevel is unaffected by either change. No 3yr-back observation
        // exists in a 36-month window for k=0 (35-36 = -1, out of range), so only these two blend.
        var history = new decimal[36];
        for (var i = 0; i < 36; i++) history[i] = 10m; // flat baseline
        history[23] = 30m; // 1 year back from current month
        history[11] = 0m;  // 2 years back from current month

        var result = PredictedUsageHelper.ComputePredictedUsage(history);

        var overallAverage = (34m * 10m + 30m + 0m) / 36m;
        var seasonalRaw = (30m * 3 + 0m * 2) / 5m; // weighted average of the two available observations
        var expectedSeasonalIndex = Math.Min(4m, seasonalRaw / overallAverage);
        const decimal baseLevel = 10m; // last 12 months (indices 24..35) all untouched
        var expected = Math.Max(0, baseLevel * expectedSeasonalIndex);

        Assert.Equal(Math.Round(expected, 6), Math.Round(result[0], 6));
    }
}
