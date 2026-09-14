using Moq;
using NormantonNexus.Helpers.Warehouse;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Warehouse;

// ExecuteAsync's kind-validation guard is the one path here that runs
// before any DB/SAP call — the transfer/consignment success paths all need
// a live SqlConnection + real SapServer call, the same testability ceiling
// as WarehouseStockHelper's own transfer-order/consignment-mb1b methods
// (neither of which have a test file either). MockBehavior.Strict on both
// collaborators so a guard that fails to fire (and accidentally reaches
// SapServer or the audit logger) is actually caught, not silently ignored.
public class WarehouseBatchCleanupHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    [Fact]
    public async Task ExecuteAsync_rejects_an_unknown_kind_without_touching_sap_or_the_db()
    {
        var db = UnreachableDb();
        var sap = new Mock<ISapServerClient>(MockBehavior.Strict);
        var audit = new Mock<IAuditLogger>(MockBehavior.Strict);

        var result = await WarehouseBatchCleanupHelper.ExecuteAsync(
            db.Object, sap.Object, audit.Object,
            new BatchCleanupItem("not-a-real-kind", null, null),
            username: "tester", ipAddress: "127.0.0.1", userId: 1, CancellationToken.None);

        Assert.False(result.Success);
        Assert.Equal("kind must be 'transfer' or 'consignment'", result.Message);
        Assert.Null(result.TransferOrderNumber);
        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task ExecuteAsync_rejects_a_transfer_kind_with_no_transfer_payload()
    {
        var db = UnreachableDb();
        var sap = new Mock<ISapServerClient>(MockBehavior.Strict);
        var audit = new Mock<IAuditLogger>(MockBehavior.Strict);

        var result = await WarehouseBatchCleanupHelper.ExecuteAsync(
            db.Object, sap.Object, audit.Object,
            new BatchCleanupItem("transfer", null, null),
            username: "tester", ipAddress: "127.0.0.1", userId: 1, CancellationToken.None);

        Assert.False(result.Success);
        Assert.Equal("transfer payload required", result.Message);
        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task ExecuteAsync_rejects_a_consignment_kind_with_no_consignment_payload()
    {
        var db = UnreachableDb();
        var sap = new Mock<ISapServerClient>(MockBehavior.Strict);
        var audit = new Mock<IAuditLogger>(MockBehavior.Strict);

        var result = await WarehouseBatchCleanupHelper.ExecuteAsync(
            db.Object, sap.Object, audit.Object,
            new BatchCleanupItem("consignment", null, null),
            username: "tester", ipAddress: "127.0.0.1", userId: 1, CancellationToken.None);

        Assert.False(result.Success);
        Assert.Equal("consignment payload required", result.Message);
        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }
}
