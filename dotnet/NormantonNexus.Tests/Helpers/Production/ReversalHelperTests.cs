using Moq;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Production;

// SearchAsync/FindAsync/MarkReversedAsync all validate before ever opening
// a connection; ExecuteAsync validates before ever calling SapServer.
// GetByBatchAsync/BulkReverseAsync always open a connection unconditionally
// (same caveat as everywhere else in this migration).
public class ReversalHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    private static Mock<ISapServerClient> UnreachableSap()
    {
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<BdcResponse>(It.IsAny<string>(), It.IsAny<object>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return sap;
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public async Task SearchAsync_rejects_a_missing_materialDocument_without_opening_a_connection(string? materialDocument)
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            ReversalHelper.SearchAsync(db.Object, materialDocument, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task FindAsync_rejects_an_all_empty_query_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            ReversalHelper.FindAsync(db.Object, new ReversalFindQuery(null, null, null, null), CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task MarkReversedAsync_rejects_a_missing_reversalDocumentSAP_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var sap = UnreachableSap();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            ReversalHelper.MarkReversedAsync(db.Object, sap.Object, sapPostingId: 1, new ReversalMarkRequest(""), userId: 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task ExecuteAsync_rejects_a_missing_materialDocument_without_calling_SapServer()
    {
        var sap = UnreachableSap();
        var audit = new Mock<IAuditLogger>();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            ReversalHelper.ExecuteAsync(sap.Object, audit.Object, "", username: "u", ipAddress: null, userId: 1, CancellationToken.None));

        sap.Verify(s => s.PostAsync<BdcResponse>(It.IsAny<string>(), It.IsAny<object>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()), Times.Never);
    }
}
