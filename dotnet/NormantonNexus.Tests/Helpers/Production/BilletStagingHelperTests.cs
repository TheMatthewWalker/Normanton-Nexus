using Moq;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Production;

// GetQueueAsync/StageAsync/ReturnToConditioningAsync's success paths and
// SearchTubsAsync all open a real SQL connection unconditionally — same
// caveat as everywhere else in this migration. StageByRefAsync's
// ticket-format check and ReturnToConditioningAsync's quantity check both
// validate before ever opening a connection.
public class BilletStagingHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    [Theory]
    [InlineData("")]
    [InlineData("garbage")]
    [InlineData("MX00000064T1")] // missing the required hyphens
    public async Task StageByRefAsync_rejects_an_unrecognised_ticket_format_without_opening_a_connection(string reference)
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            BilletStagingHelper.StageByRefAsync(db.Object, new StageByRefRequest(reference), userId: 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task ReturnToConditioningAsync_throws_when_quantity_is_not_positive_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            BilletStagingHelper.ReturnToConditioningAsync(db.Object, tubId: 1, new ReturnToConditioningRequest(0m, null), userId: 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }
}
