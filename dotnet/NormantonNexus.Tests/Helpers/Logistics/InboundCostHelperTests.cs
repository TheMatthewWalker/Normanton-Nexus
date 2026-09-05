using Moq;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class InboundCostHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    [Fact]
    public async Task AddAsync_rejects_a_missing_poShipmentId_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = new AddInboundCostLineRequest(null, "standard", 100m, "ITLG01A", null, null, null);

        await Assert.ThrowsAsync<NexusValidationException>(() => InboundCostHelper.AddAsync(db.Object, body, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(0d)]
    [InlineData(-1d)]
    public async Task AddAsync_rejects_a_non_positive_amount_without_opening_a_connection(double? amount)
    {
        var db = UnreachableDb();
        var body = new AddInboundCostLineRequest(1, "standard", (decimal?)amount, "ITLG01A", null, null, null);

        await Assert.ThrowsAsync<NexusValidationException>(() => InboundCostHelper.AddAsync(db.Object, body, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task AddAsync_rejects_a_blank_costType_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = new AddInboundCostLineRequest(1, "standard", 100m, "  ", null, null, null);

        await Assert.ThrowsAsync<NexusValidationException>(() => InboundCostHelper.AddAsync(db.Object, body, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task UpdateAsync_rejects_a_non_positive_amount_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = new UpdateInboundCostLineRequest("standard", 0m, "ITLG01A", null);

        await Assert.ThrowsAsync<NexusValidationException>(() => InboundCostHelper.UpdateAsync(db.Object, 1, body, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task UpdateAsync_rejects_a_blank_costType_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = new UpdateInboundCostLineRequest("standard", 100m, "", null);

        await Assert.ThrowsAsync<NexusValidationException>(() => InboundCostHelper.UpdateAsync(db.Object, 1, body, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }
}
