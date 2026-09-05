using Moq;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Production;

// Every ProductionReportsHelper method and ProductionHelper.GetHistoryAsync/
// GetTraceChainAsync open a real SQL connection unconditionally before any
// other logic runs (INexusOperationsDb.CreateConnectionAsync actually opens
// one) — untestable in this sandbox, same caveat as ProductionScheduleHelper
// and most of StockCountHelper. AddTraceLinkAsync is the one exception: it
// validates its input before ever calling CreateConnectionAsync.
public class ProductionHelperTests
{
    [Theory]
    [InlineData("", 1, "EX", 2)]
    [InlineData("DR", 0, "EX", 2)]
    [InlineData("DR", 1, "", 2)]
    [InlineData("DR", 1, "EX", 0)]
    public async Task AddTraceLinkAsync_throws_for_missing_fields_without_opening_a_connection(
        string childProcessCode, int childRecordId, string parentProcessCode, int parentRecordId)
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));

        var body = new TraceLinkCreateRequest(childProcessCode, childRecordId, parentProcessCode, parentRecordId);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            ProductionHelper.AddTraceLinkAsync(db.Object, body, "alice", userId: 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }
}
