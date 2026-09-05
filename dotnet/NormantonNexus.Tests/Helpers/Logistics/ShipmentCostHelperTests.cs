using Moq;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Logistics;

// Same precedent as PalletPackagesHelperTests: UpdateAsync/CreateAsync/
// CreateManualAsync/UpdateManualAsync all validate before ever opening a
// connection, so their pre-connection guard paths are testable against a
// mock that throws if CreateConnectionAsync is ever actually called.
public class ShipmentCostHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    private static ManualShipmentCostRequest SampleManual() => new(
        Direction: "outbound", Tier: "standard", CostType: "ITLG01A", CostCenter: "4200", ExpectedCost: 100m,
        ForwarderId: 5, ModeOfTransport: "Road", IncurredDate: new DateTime(2026, 1, 1), Reference: "INV-1",
        Country: "GB", Postcode: "WF6 1TN", TrackingNumber: null, CostElement: null);

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public async Task UpdateAsync_rejects_a_non_positive_expectedCost_without_opening_a_connection(decimal expectedCost)
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            ShipmentCostHelper.UpdateAsync(db.Object, 1, new UpdateShipmentCostRequest(expectedCost, null, null, null), CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task UpdateAsync_rejects_a_blank_costElement_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            ShipmentCostHelper.UpdateAsync(db.Object, 1, new UpdateShipmentCostRequest(100m, "  ", null, null), CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task CreateAsync_rejects_a_body_with_neither_shipmentId_nor_poShipmentId()
    {
        var db = UnreachableDb();
        var body = new CreateShipmentCostRequest(null, null, "ITLG01A", "6100", "4200", 100m, null, null, null, null);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            ShipmentCostHelper.CreateAsync(db.Object, body, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task CreateAsync_rejects_a_non_positive_expectedCost()
    {
        var db = UnreachableDb();
        var body = new CreateShipmentCostRequest(42, null, "ITLG01A", "6100", "4200", 0m, null, null, null, null);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            ShipmentCostHelper.CreateAsync(db.Object, body, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Theory]
    [InlineData("sideways")]
    [InlineData("")]
    public async Task CreateManualAsync_rejects_an_invalid_direction(string direction)
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            ShipmentCostHelper.CreateManualAsync(db.Object, SampleManual() with { Direction = direction }, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task CreateManualAsync_rejects_an_invalid_tier()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            ShipmentCostHelper.CreateManualAsync(db.Object, SampleManual() with { Tier = "gold" }, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task CreateManualAsync_requires_a_positive_forwarderId()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            ShipmentCostHelper.CreateManualAsync(db.Object, SampleManual() with { ForwarderId = 0 }, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task CreateManualAsync_requires_a_reference()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            ShipmentCostHelper.CreateManualAsync(db.Object, SampleManual() with { Reference = " " }, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task UpdateManualAsync_applies_the_same_validation_as_CreateManualAsync()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            ShipmentCostHelper.UpdateManualAsync(db.Object, 1, SampleManual() with { CostType = "" }, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }
}
