using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models.Dto;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class PerformanceDashboardHelperTests
{
    // ── ShapeValueMetrics ────────────────────────────────────────────────

    [Fact]
    public void ShapeValueMetrics_pivots_rows_by_date_then_ValueStream()
    {
        var rows = new[]
        {
            new ValueMetricRawRow(new DateTime(2026, 1, 1), "PTFE", 100m, 50m, 25m),
            new ValueMetricRawRow(new DateTime(2026, 1, 1), "PV", 40m, 10m, 5m),
        };

        var result = PerformanceDashboardHelper.ShapeValueMetrics(rows);

        var day = Assert.Single(result);
        Assert.Equal("2026-01-01", day.Date);
        Assert.Equal(new ValueMetricStream(100m, 50m, 25m), day.Streams["PTFE"]);
        Assert.Equal(new ValueMetricStream(40m, 10m, 5m), day.Streams["PV"]);
    }

    [Fact]
    public void ShapeValueMetrics_sums_multiple_rows_for_the_same_date_and_stream()
    {
        var rows = new[]
        {
            new ValueMetricRawRow(new DateTime(2026, 1, 1), "PTFE", 100m, 50m, 25m),
            new ValueMetricRawRow(new DateTime(2026, 1, 1), "PTFE", 10m, 5m, 2m),
        };

        var result = PerformanceDashboardHelper.ShapeValueMetrics(rows);

        Assert.Equal(new ValueMetricStream(110m, 55m, 27m), result[0].Streams["PTFE"]);
    }

    [Fact]
    public void ShapeValueMetrics_treats_null_values_as_zero()
    {
        var rows = new[] { new ValueMetricRawRow(new DateTime(2026, 1, 1), "PTFE", null, null, null) };

        var result = PerformanceDashboardHelper.ShapeValueMetrics(rows);

        Assert.Equal(new ValueMetricStream(0m, 0m, 0m), result[0].Streams["PTFE"]);
    }

    [Fact]
    public void ShapeValueMetrics_preserves_date_order_as_encountered()
    {
        var rows = new[]
        {
            new ValueMetricRawRow(new DateTime(2026, 1, 2), "PTFE", 1m, 1m, 1m),
            new ValueMetricRawRow(new DateTime(2026, 1, 1), "PTFE", 1m, 1m, 1m),
        };

        var result = PerformanceDashboardHelper.ShapeValueMetrics(rows);

        Assert.Equal(["2026-01-02", "2026-01-01"], result.Select(r => r.Date));
    }

    // ── ShapeOtifMetrics ─────────────────────────────────────────────────

    [Fact]
    public void ShapeOtifMetrics_computes_a_running_on_time_ratio()
    {
        var rows = new[] { new OtifMetricRawRow(new DateTime(2026, 1, 1), "PTFE", 8, 10) };

        var result = PerformanceDashboardHelper.ShapeOtifMetrics(rows);

        var stream = result[0].Streams["PTFE"];
        Assert.Equal(8, stream.OnTime);
        Assert.Equal(10, stream.Total);
        Assert.Equal(0.8m, stream.Otif);
    }

    [Fact]
    public void ShapeOtifMetrics_accumulates_across_multiple_rows_and_recomputes_the_ratio()
    {
        var rows = new[]
        {
            new OtifMetricRawRow(new DateTime(2026, 1, 1), "PTFE", 8, 10),
            new OtifMetricRawRow(new DateTime(2026, 1, 1), "PTFE", 1, 10),
        };

        var result = PerformanceDashboardHelper.ShapeOtifMetrics(rows);

        var stream = result[0].Streams["PTFE"];
        Assert.Equal(9, stream.OnTime);
        Assert.Equal(20, stream.Total);
        Assert.Equal(0.45m, stream.Otif);
    }

    [Fact]
    public void ShapeOtifMetrics_returns_zero_ratio_when_total_is_zero()
    {
        var rows = new[] { new OtifMetricRawRow(new DateTime(2026, 1, 1), "PTFE", 0, 0) };

        var result = PerformanceDashboardHelper.ShapeOtifMetrics(rows);

        Assert.Equal(0m, result[0].Streams["PTFE"].Otif);
    }

    // ── ShapeRefreshStatus ───────────────────────────────────────────────

    [Fact]
    public void ShapeRefreshStatus_reports_Missing_for_a_dataset_with_no_run_recorded()
    {
        var result = PerformanceDashboardHelper.ShapeRefreshStatus(["Stock", "Otif"], []);

        Assert.Equal("Missing", result.Datasets.Single(d => d.Name == "Stock").Status);
        Assert.Equal(2, result.Failures.Count);
        Assert.Null(result.LastRefreshUtc);
    }

    [Fact]
    public void ShapeRefreshStatus_takes_the_most_recent_run_per_dataset()
    {
        var rows = new[]
        {
            new RefreshLogRow(2, "Stock", "Success", new DateTime(2026, 1, 2), null),
            new RefreshLogRow(1, "Stock", "Failed", new DateTime(2026, 1, 1), "boom"),
        };

        var result = PerformanceDashboardHelper.ShapeRefreshStatus(["Stock"], rows);

        Assert.Equal("Success", result.Datasets[0].Status);
        Assert.Equal(new DateTime(2026, 1, 2), result.Datasets[0].CompletedAtUtc);
    }

    [Fact]
    public void ShapeRefreshStatus_returns_the_latest_completion_time_when_every_dataset_succeeded()
    {
        var rows = new[]
        {
            new RefreshLogRow(1, "Stock", "Success", new DateTime(2026, 1, 1), null),
            new RefreshLogRow(2, "Otif", "Success", new DateTime(2026, 1, 3), null),
        };

        var result = PerformanceDashboardHelper.ShapeRefreshStatus(["Stock", "Otif"], rows);

        Assert.Equal(new DateTime(2026, 1, 3), result.LastRefreshUtc);
        Assert.Empty(result.Failures);
    }

    [Fact]
    public void ShapeRefreshStatus_shows_null_lastRefreshUtc_when_any_dataset_failed_even_if_others_succeeded()
    {
        var rows = new[]
        {
            new RefreshLogRow(1, "Stock", "Success", new DateTime(2026, 1, 1), null),
            new RefreshLogRow(2, "Otif", "Failed", new DateTime(2026, 1, 1), "boom"),
        };

        var result = PerformanceDashboardHelper.ShapeRefreshStatus(["Stock", "Otif"], rows);

        Assert.Null(result.LastRefreshUtc);
        Assert.Single(result.Failures);
        Assert.Equal("Otif", result.Failures[0].Name);
    }
}
