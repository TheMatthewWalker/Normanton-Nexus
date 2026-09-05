using Moq;
using NormantonNexus.Helpers.StockCount;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.StockCount;

// Every other StockCountHelper method (ListCountsAsync, ApproveAsync,
// GetFinanceReportAsync) opens a real SQL connection unconditionally before
// any other logic runs, so there's no validation-only path to test without
// a live SQL Server — same caveat as ProductionScheduleHelper. These two
// methods are the exceptions: both validate their input before ever
// calling CreateConnectionAsync.
public class StockCountHelperTests
{
    [Fact]
    public async Task GetCountReportAsync_rejects_groupBy_bin_as_out_of_scope_for_this_migration_without_opening_a_connection()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            StockCountHelper.GetCountReportAsync(db.Object, countId: 1, groupBy: "bin", CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task RejectAsync_throws_for_a_blank_reason_without_opening_a_connection()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            StockCountHelper.RejectAsync(db.Object, countId: 1, new RejectCountRequest("   "), "alice", CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    // ── MostRecentMonday ─────────────────────────────────────────────────
    // Pure port of routes/stockcount.js's mostRecentMonday: (dayOfWeek + 6) % 7
    // days back, Sunday=0. No DB involved — the one piece of the PTFE Weekly
    // Cycle Count feature (Phase 10 Slice 3's third and final originally-
    // missing cron-backed feature) testable without a live SQL Server.

    [Theory]
    [InlineData("2026-09-07", "2026-09-07")] // Monday -> itself
    [InlineData("2026-09-08", "2026-09-07")] // Tuesday -> this week's Monday
    [InlineData("2026-09-05", "2026-08-31")] // Saturday -> this week's Monday (previous calendar week)
    [InlineData("2026-09-06", "2026-08-31")] // Sunday -> this week's Monday (day-of-week 0, wraps a full 6 days back)
    public void MostRecentMonday_returns_the_Monday_of_the_current_week(string nowDate, string expectedMonday)
    {
        var now = DateTime.Parse(nowDate);
        var expected = DateTime.Parse(expectedMonday);

        Assert.Equal(expected, StockCountHelper.MostRecentMonday(now));
    }

    [Fact]
    public void MostRecentMonday_strips_the_time_component()
    {
        var now = new DateTime(2026, 9, 8, 14, 30, 45);

        Assert.Equal(new DateTime(2026, 9, 7), StockCountHelper.MostRecentMonday(now));
    }
}
