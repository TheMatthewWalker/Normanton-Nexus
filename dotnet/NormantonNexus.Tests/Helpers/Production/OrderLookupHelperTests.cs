using Moq;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Models;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Production;

// GetByOrderAsync/LoadTicketDataAsync need a live SQL Server (and, for the
// ticket, a real SapServer round-trip) to exercise for real — SearchAsync
// is the one path here that validates before ever opening a connection.
public class OrderLookupHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    [Fact]
    public async Task SearchAsync_rejects_a_search_with_neither_material_nor_customer_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            OrderLookupHelper.SearchAsync(db.Object, null, "   ", CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }
}
