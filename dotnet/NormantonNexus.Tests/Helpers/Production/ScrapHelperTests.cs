using Moq;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Models;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Production;

// Every read/bulk/retry path in ScrapHelper opens a real SQL connection
// unconditionally (same caveat as everywhere else in this migration) —
// GetDocumentsAsync's scrapId <= 0 guard is the only path that validates
// before ever opening one.
public class ScrapHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public async Task GetDocumentsAsync_rejects_a_non_positive_scrapId_without_opening_a_connection(int scrapId)
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            ScrapHelper.GetDocumentsAsync(db.Object, scrapId, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }
}
