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
}
