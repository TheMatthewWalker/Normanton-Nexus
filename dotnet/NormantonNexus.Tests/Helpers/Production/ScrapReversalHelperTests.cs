using Moq;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Production;

// SearchAsync validates before ever opening a connection. ReverseAsync's
// underlying scrapDocumentId/materialDocument guard runs after opening a
// connection (mirrors Node's own reverseScrapDocumentItem, which checks
// this after acquiring the pool) so it isn't exercised here without a real
// SQL Server. GetMissedAsync/BulkReverseAsync always open a connection
// unconditionally, same caveat as everywhere else in this migration.
public class ScrapReversalHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    [Fact]
    public async Task SearchAsync_rejects_an_all_empty_query_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            ScrapReversalHelper.SearchAsync(db.Object, new ScrapReversalSearchQuery(null, null, null, null, null, null, null), CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }
}
