using Moq;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Production;

// SubmitAsync's success path needs a live SQL Server and a real SapServer
// round-trip — untestable in this sandbox, same caveat as MetreProcessHelper
// and BomHelper. Every request-shape check (coilLengths bounds,
// material/packagingId/weightKg) runs before ever opening a connection —
// those paths are covered here.
public class DrummingHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    private static readonly DrummingSubmitRequest ValidRequest = new(
        Material: "MAT-1", ShiftId: null,
        CustomerNumber: null, OrderNumber: null, OrderItem: null,
        PackagingId: "SD", WeightKg: 25m,
        ParentBatches: null, RawMaterialBatches: null,
        CoilLengths: [100m, 100m],
        HasScrap: false, ScrapTotalKg: null, ScrapReasons: null,
        Comments: null);

    [Fact]
    public async Task SubmitAsync_rejects_empty_coilLengths_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = ValidRequest with { CoilLengths = [] };

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            DrummingHelper.SubmitAsync(db.Object, Mock.Of<ISapServerClient>(), Mock.Of<IAuditLogger>(), "stock", body, "alice", "127.0.0.1", 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task SubmitAsync_rejects_more_than_1000_coilLengths_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = ValidRequest with { CoilLengths = Enumerable.Repeat(1m, 1001).ToList() };

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            DrummingHelper.SubmitAsync(db.Object, Mock.Of<ISapServerClient>(), Mock.Of<IAuditLogger>(), "stock", body, "alice", "127.0.0.1", 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task SubmitAsync_rejects_a_missing_material_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = ValidRequest with { Material = null };

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            DrummingHelper.SubmitAsync(db.Object, Mock.Of<ISapServerClient>(), Mock.Of<IAuditLogger>(), "stock", body, "alice", "127.0.0.1", 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task SubmitAsync_rejects_a_missing_packagingId_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = ValidRequest with { PackagingId = null };

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            DrummingHelper.SubmitAsync(db.Object, Mock.Of<ISapServerClient>(), Mock.Of<IAuditLogger>(), "customer", body, "alice", "127.0.0.1", 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(0.0)]
    [InlineData(-1.0)]
    public async Task SubmitAsync_rejects_a_non_positive_weightKg_without_opening_a_connection(double? weightKg)
    {
        var db = UnreachableDb();
        var body = ValidRequest with { WeightKg = weightKg.HasValue ? (decimal)weightKg.Value : null };

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            DrummingHelper.SubmitAsync(db.Object, Mock.Of<ISapServerClient>(), Mock.Of<IAuditLogger>(), "stock", body, "alice", "127.0.0.1", 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }
}
