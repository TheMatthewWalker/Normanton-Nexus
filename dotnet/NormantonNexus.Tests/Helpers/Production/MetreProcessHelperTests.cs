using Moq;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Production;

// Success paths need a live SQL Server and a real SapServer round-trip —
// untestable in this sandbox. Every method here validates the process
// code (and, for EnterAsync, material/lengthMetres) before ever opening a
// connection, so those paths are covered.
public class MetreProcessHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    [Theory]
    [InlineData("MX")] // a real process code, just not one of the 5 metre processes
    [InlineData("ZZ")]
    public async Task EnterAsync_rejects_a_non_metre_process_code_without_opening_a_connection(string processCode)
    {
        var db = UnreachableDb();
        var body = new MetreProcessEntryRequest("MAT1", 10m, null, null, null, null, false, null, null, null);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MetreProcessHelper.EnterAsync(processCode, db.Object, Mock.Of<ISapServerClient>(), Mock.Of<IAuditLogger>(), body, "alice", "127.0.0.1", 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task EnterAsync_throws_when_material_is_missing()
    {
        var db = UnreachableDb();
        var body = new MetreProcessEntryRequest(null, 10m, null, null, null, null, false, null, null, null);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MetreProcessHelper.EnterAsync("EX", db.Object, Mock.Of<ISapServerClient>(), Mock.Of<IAuditLogger>(), body, "alice", "127.0.0.1", 1, CancellationToken.None));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public async Task EnterAsync_throws_when_lengthMetres_is_not_positive(double length)
    {
        var db = UnreachableDb();
        var body = new MetreProcessEntryRequest("MAT1", (decimal)length, null, null, null, null, false, null, null, null);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MetreProcessHelper.EnterAsync("EX", db.Object, Mock.Of<ISapServerClient>(), Mock.Of<IAuditLogger>(), body, "alice", "127.0.0.1", 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task GetOpenEntriesAsync_rejects_a_non_metre_process_code_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MetreProcessHelper.GetOpenEntriesAsync("DR", db.Object, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task GetDataAsync_rejects_a_non_metre_process_code_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MetreProcessHelper.GetDataAsync("HA", db.Object, new MetreProcessDataQuery(null, null, null), CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task CancelOpenRunAsync_rejects_an_unknown_process_code_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MetreProcessHelper.CancelOpenRunAsync("ZZ", 1, db.Object, new CancelOpenRunRequest(null), 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task DraftAsync_rejects_a_non_metre_process_code_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MetreProcessHelper.DraftAsync("DR", db.Object, Mock.Of<ISapServerClient>(), new MetreDraftRequest("MAT1", null, null, null, null), 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task DraftAsync_rejects_a_missing_material_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MetreProcessHelper.DraftAsync("CO", db.Object, Mock.Of<ISapServerClient>(), new MetreDraftRequest(null, null, null, null, null), 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task CompleteAsync_rejects_a_non_metre_process_code_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = new MetreCompleteRequest(10m, null, null, false, null, null, null);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MetreProcessHelper.CompleteAsync("DR", 1, db.Object, Mock.Of<ISapServerClient>(), Mock.Of<IAuditLogger>(), body, "alice", "127.0.0.1", 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(0.0)]
    [InlineData(-1.0)]
    public async Task CompleteAsync_rejects_a_non_positive_lengthMetres_without_opening_a_connection(double? length)
    {
        var db = UnreachableDb();
        var body = new MetreCompleteRequest(length.HasValue ? (decimal)length.Value : null, null, null, false, null, null, null);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MetreProcessHelper.CompleteAsync("CL", 1, db.Object, Mock.Of<ISapServerClient>(), Mock.Of<IAuditLogger>(), body, "alice", "127.0.0.1", 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }
}
