using Moq;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class IsoparDeclarationHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    [Fact]
    public async Task CreateDeclarationAsync_rejects_a_missing_periodStart_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            IsoparDeclarationHelper.CreateDeclarationAsync(db.Object, new CreateIsoparDeclarationRequest(null, new DateTime(2026, 10, 31), null), 1, "alice", CancellationToken.None));
    }

    [Fact]
    public async Task CreateDeclarationAsync_rejects_a_missing_periodEnd_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            IsoparDeclarationHelper.CreateDeclarationAsync(db.Object, new CreateIsoparDeclarationRequest(new DateTime(2026, 8, 1), null, null), 1, "alice", CancellationToken.None));
    }
}
