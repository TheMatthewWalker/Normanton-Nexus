using Moq;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Logistics;

// Same precedent as ShipmentCostHelperTests: every Create/Update method validates before ever
// opening a connection, so those pre-connection guard paths are testable against a mock that
// throws if CreateConnectionAsync is ever actually called.
public class VendorMasterDataHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    private static UpsertVendorRequest SampleVendor(string? vendorName = "Acme Ltd") =>
        new(vendorName!, "0000200604", "GBP", "DAP", 500m, 5000m, "KG", 14m, 3m, null);

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public async Task CreateVendorAsync_rejects_a_blank_vendorName_without_opening_a_connection(string? vendorName)
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            VendorMasterDataHelper.CreateVendorAsync(db.Object, SampleVendor(vendorName), CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task UpdateVendorAsync_rejects_a_blank_vendorName_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            VendorMasterDataHelper.UpdateVendorAsync(db.Object, 1, SampleVendor(""), CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task AddVendorMaterialAsync_rejects_a_blank_material_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = new AddVendorMaterialRequest("", null, null, null, null, null, null, null);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            VendorMasterDataHelper.AddVendorMaterialAsync(db.Object, 1, body, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task CreateDemandAdjustmentAsync_rejects_a_blank_material_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = new UpsertDemandAdjustmentRequest("", null, null, 100m, null);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            VendorMasterDataHelper.CreateDemandAdjustmentAsync(db.Object, body, "tester", CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(-1d)]
    public async Task CreateDemandAdjustmentAsync_rejects_a_missing_or_negative_usagePercent_without_opening_a_connection(double? usagePercent)
    {
        var db = UnreachableDb();
        var body = new UpsertDemandAdjustmentRequest("MAT001", null, null, (decimal?)usagePercent, null);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            VendorMasterDataHelper.CreateDemandAdjustmentAsync(db.Object, body, "tester", CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task CreateDemandAdjustmentAsync_accepts_a_literal_zero_usagePercent()
    {
        // usagePercent == null is rejected, but a literal 0 is a valid "fully suppressed" adjustment
        // — distinct cases, matching Node's `usagePercent == null || Number(usagePercent) < 0`.
        var db = UnreachableDb(); // still throws once past validation, but proves 0 clears the guard
        var body = new UpsertDemandAdjustmentRequest("MAT001", null, null, 0m, null);

        var ex = await Record.ExceptionAsync(() =>
            VendorMasterDataHelper.CreateDemandAdjustmentAsync(db.Object, body, "tester", CancellationToken.None));

        Assert.IsType<InvalidOperationException>(ex); // reached the mock's "should not be called" connection throw, not a validation error
    }

    [Fact]
    public async Task UpdateDemandAdjustmentAsync_rejects_a_negative_usagePercent_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var body = new UpsertDemandAdjustmentRequest("MAT001", null, null, -5m, null);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            VendorMasterDataHelper.UpdateDemandAdjustmentAsync(db.Object, 1, body, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }
}
