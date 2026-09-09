using NormantonNexus.Helpers.Warehouse;

namespace NormantonNexus.Tests.Helpers.Warehouse;

// All pure, no I/O -- fully testable. 2024-01-01 was a real Monday, so
// fixed reference dates that week (and the following Monday, 2024-01-08)
// are used instead of relying on DateTime.Now, matching this migration's
// "pure functions get real unit tests" precedent (WarehousePicksheetHelper.
// ParseSapQuantity, RedrumReversalHelper.PadCostCollectorBin).
public class StoresWorkingHoursHelperTests
{
    private static readonly DateTime Wed = new(2024, 1, 3);
    private static readonly DateTime Thu = new(2024, 1, 4);
    private static readonly DateTime Fri = new(2024, 1, 5);
    private static readonly DateTime Sat = new(2024, 1, 6);
    private static readonly DateTime Sun = new(2024, 1, 7);
    private static readonly DateTime NextMon = new(2024, 1, 8); // the Monday AFTER Sat/Sun above

    [Theory]
    [InlineData(2024, 1, 1, true)]  // Monday
    [InlineData(2024, 1, 5, true)]  // Friday
    [InlineData(2024, 1, 6, false)] // Saturday
    [InlineData(2024, 1, 7, false)] // Sunday
    public void IsStoresWorkingDay_is_true_only_Monday_through_Friday(int y, int m, int d, bool expected)
    {
        Assert.Equal(expected, StoresWorkingHoursHelper.IsStoresWorkingDay(new DateTime(y, m, d)));
    }

    [Fact]
    public void SnapToStoresWindow_leaves_a_pick_already_inside_the_working_window_unchanged()
    {
        var pick = Wed.AddHours(10); // Wednesday 10:00, inside 05:45-17:00
        Assert.Equal(pick, StoresWorkingHoursHelper.SnapToStoresWindow(pick));
    }

    [Fact]
    public void SnapToStoresWindow_snaps_an_early_morning_pick_forward_to_todays_open()
    {
        var pick = Wed.AddHours(3); // 03:00 -- 10 hours from the previous close, past the grace window
        var expected = Wed.AddHours(5).AddMinutes(45); // today's 05:45 open
        Assert.Equal(expected, StoresWorkingHoursHelper.SnapToStoresWindow(pick));
    }

    [Fact]
    public void SnapToStoresWindow_pulls_a_pick_just_after_close_back_to_that_close()
    {
        var pick = Fri.AddHours(18); // 18:00 -- 1 hour after the 17:00 close, within the 4-hour lead time
        var expected = Fri.AddHours(17);
        Assert.Equal(expected, StoresWorkingHoursHelper.SnapToStoresWindow(pick));
    }

    [Fact]
    public void SnapToStoresWindow_pushes_a_weekend_pick_to_the_next_Monday_open()
    {
        var pick = Sat.AddHours(10);
        var expected = NextMon.AddHours(5).AddMinutes(45);
        Assert.Equal(expected, StoresWorkingHoursHelper.SnapToStoresWindow(pick));
    }

    [Fact]
    public void SnapToStoresWindow_pushes_a_Sunday_pick_to_the_next_Monday_open()
    {
        var pick = Sun.AddHours(20);
        var expected = NextMon.AddHours(5).AddMinutes(45);
        Assert.Equal(expected, StoresWorkingHoursHelper.SnapToStoresWindow(pick));
    }

    [Fact]
    public void AddStoresLeadTime_stays_within_the_same_working_day_when_there_is_room()
    {
        var from = Wed.AddHours(10); // 10:00, 7 hours until close
        var expected = Wed.AddHours(14);
        Assert.Equal(expected, StoresWorkingHoursHelper.AddStoresLeadTime(from, 4));
    }

    [Fact]
    public void AddStoresLeadTime_rolls_the_overflow_into_the_next_working_days_open()
    {
        // 15:00 + 4 hours: 2 hours to close (17:00), 2 more hours from the
        // next working day's 05:45 open -> 07:45 the next working day.
        var from = Wed.AddHours(15);
        var expected = Thu.AddHours(7).AddMinutes(45);
        Assert.Equal(expected, StoresWorkingHoursHelper.AddStoresLeadTime(from, 4));
    }

    [Fact]
    public void AddStoresLeadTime_skips_the_weekend_when_the_overflow_lands_on_a_Friday_close()
    {
        var from = Fri.AddHours(16); // 1 hour to close
        var expected = NextMon.AddHours(5).AddMinutes(45).AddHours(3); // 3 hours remaining after the 1 available on Friday
        Assert.Equal(expected, StoresWorkingHoursHelper.AddStoresLeadTime(from, 4));
    }

    [Fact]
    public void FormatStoresTime_renders_day_month_hour_minute_zero_padded()
    {
        Assert.Equal("03/01 05:45", StoresWorkingHoursHelper.FormatStoresTime(Wed.AddHours(5).AddMinutes(45)));
    }

    [Fact]
    public void FormatLocalDateTime_renders_full_date_including_year()
    {
        Assert.Equal("03/01/2024 17:00", StoresWorkingHoursHelper.FormatLocalDateTime(Wed.AddHours(17)));
    }
}
