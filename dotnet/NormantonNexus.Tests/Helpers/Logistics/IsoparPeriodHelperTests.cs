using NormantonNexus.Helpers.Logistics;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class IsoparPeriodHelperTests
{
    [Fact]
    public void IsoparPeriodBounds_period_0_starts_at_the_anchor_and_spans_3_calendar_months()
    {
        var (start, end) = IsoparPeriodHelper.IsoparPeriodBounds(0);

        Assert.Equal(new DateTime(2026, 8, 1, 0, 0, 0, DateTimeKind.Utc), start);
        Assert.Equal(new DateTime(2026, 10, 31, 0, 0, 0, DateTimeKind.Utc), end);
    }

    [Fact]
    public void IsoparPeriodBounds_period_1_immediately_follows_period_0()
    {
        var (start, end) = IsoparPeriodHelper.IsoparPeriodBounds(1);

        Assert.Equal(new DateTime(2026, 11, 1, 0, 0, 0, DateTimeKind.Utc), start);
        Assert.Equal(new DateTime(2027, 1, 31, 0, 0, 0, DateTimeKind.Utc), end);
    }

    [Fact]
    public void IsoparPeriodBounds_period_2_naturally_handles_a_non_leap_February()
    {
        var (start, end) = IsoparPeriodHelper.IsoparPeriodBounds(2);

        Assert.Equal(new DateTime(2027, 2, 1, 0, 0, 0, DateTimeKind.Utc), start);
        Assert.Equal(new DateTime(2027, 4, 30, 0, 0, 0, DateTimeKind.Utc), end);
    }

    [Theory]
    [InlineData(2026, 8, 1, 0)]
    [InlineData(2026, 10, 31, 0)]
    [InlineData(2026, 11, 1, 1)]
    [InlineData(2027, 1, 31, 1)]
    [InlineData(2027, 2, 1, 2)]
    public void IsoparPeriodIndexForDate_buckets_a_date_into_the_right_period(int year, int month, int day, int expectedIndex)
    {
        var date = new DateTime(year, month, day, 0, 0, 0, DateTimeKind.Utc);
        Assert.Equal(expectedIndex, IsoparPeriodHelper.IsoparPeriodIndexForDate(date));
    }

    [Fact]
    public void IsoparPeriodContaining_returns_the_bounds_of_the_period_the_date_falls_in()
    {
        var date = new DateTime(2026, 12, 15, 0, 0, 0, DateTimeKind.Utc);
        var (start, end) = IsoparPeriodHelper.IsoparPeriodContaining(date);

        Assert.Equal(new DateTime(2026, 11, 1, 0, 0, 0, DateTimeKind.Utc), start);
        Assert.Equal(new DateTime(2027, 1, 31, 0, 0, 0, DateTimeKind.Utc), end);
    }

    [Fact]
    public void IsoparPeriodsEndedBefore_returns_nothing_before_the_anchor_period_has_ended()
    {
        var date = new DateTime(2026, 9, 15, 0, 0, 0, DateTimeKind.Utc);
        var periods = IsoparPeriodHelper.IsoparPeriodsEndedBefore(date);

        Assert.Empty(periods);
    }

    [Fact]
    public void IsoparPeriodsEndedBefore_excludes_a_period_on_the_last_calendar_day_of_its_end_date()
    {
        // 2026-10-31 (23:59:59 inclusive) is still WITHIN period 0 — only date >= 2026-11-01
        // should count period 0 as fully ended.
        var stillWithinPeriod0 = new DateTime(2026, 10, 31, 0, 0, 0, DateTimeKind.Utc);
        Assert.Empty(IsoparPeriodHelper.IsoparPeriodsEndedBefore(stillWithinPeriod0));

        var justAfterPeriod0 = new DateTime(2026, 11, 1, 0, 0, 0, DateTimeKind.Utc);
        var periods = IsoparPeriodHelper.IsoparPeriodsEndedBefore(justAfterPeriod0);
        Assert.Single(periods);
        Assert.Equal(0, periods[0].Index);
    }

    [Fact]
    public void IsoparPeriodsEndedBefore_returns_every_fully_elapsed_period_oldest_first()
    {
        // Well into period 2 (2027-02-01..2027-04-30) — periods 0 and 1 have both fully ended.
        var date = new DateTime(2027, 3, 1, 0, 0, 0, DateTimeKind.Utc);
        var periods = IsoparPeriodHelper.IsoparPeriodsEndedBefore(date);

        Assert.Equal(2, periods.Count);
        Assert.Equal(0, periods[0].Index);
        Assert.Equal(1, periods[1].Index);
    }
}
