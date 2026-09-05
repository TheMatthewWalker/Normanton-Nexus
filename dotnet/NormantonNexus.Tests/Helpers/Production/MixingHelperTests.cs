using Moq;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Production;

// MixingHelper.EnterAsync's success/SAP-posting paths need a live SQL
// Server (INexusOperationsDb.CreateConnectionAsync actually opens a
// connection) and a real SapServer round-trip — untestable in this
// sandbox. Validation runs before either, so those paths are covered here.
public class MixingHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    [Fact]
    public async Task EnterAsync_throws_for_blank_mixCode_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = new MixingEntryRequest(null, "SB1", "ST1", [new MixingTubInput(10m)], null);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MixingHelper.EnterAsync(db.Object, Mock.Of<ISapServerClient>(), Mock.Of<IAuditLogger>(), body, "alice", "127.0.0.1", 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task EnterAsync_throws_when_no_tubs_are_given()
    {
        var db = UnreachableDb();
        var body = new MixingEntryRequest("MAT1", "SB1", "ST1", [], null);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MixingHelper.EnterAsync(db.Object, Mock.Of<ISapServerClient>(), Mock.Of<IAuditLogger>(), body, "alice", "127.0.0.1", 1, CancellationToken.None));
    }

    [Fact]
    public async Task EnterAsync_throws_when_supplier_batch_or_tub_number_is_blank()
    {
        var db = UnreachableDb();
        var body = new MixingEntryRequest("MAT1", "", "ST1", [new MixingTubInput(10m)], null);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MixingHelper.EnterAsync(db.Object, Mock.Of<ISapServerClient>(), Mock.Of<IAuditLogger>(), body, "alice", "127.0.0.1", 1, CancellationToken.None));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(38.001)]
    public async Task EnterAsync_throws_when_a_tub_weight_is_out_of_range(double weight)
    {
        var db = UnreachableDb();
        var body = new MixingEntryRequest("MAT1", "SB1", "ST1", [new MixingTubInput((decimal)weight)], null);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MixingHelper.EnterAsync(db.Object, Mock.Of<ISapServerClient>(), Mock.Of<IAuditLogger>(), body, "alice", "127.0.0.1", 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task EnterAsync_accepts_a_tub_weight_of_exactly_the_38kg_maximum()
    {
        // 38.000 is a valid boundary value — only opens a connection once
        // past validation, which then fails against this mock (no real DB),
        // proving the weight check itself didn't reject it.
        var db = UnreachableDb();
        var body = new MixingEntryRequest("MAT1", "SB1", "ST1", [new MixingTubInput(38m)], null);

        var ex = await Record.ExceptionAsync(() =>
            MixingHelper.EnterAsync(db.Object, Mock.Of<ISapServerClient>(), Mock.Of<IAuditLogger>(), body, "alice", "127.0.0.1", 1, CancellationToken.None));

        Assert.IsNotType<NexusValidationException>(ex);
    }
}
