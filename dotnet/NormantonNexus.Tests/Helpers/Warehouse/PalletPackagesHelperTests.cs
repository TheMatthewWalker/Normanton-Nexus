using Moq;
using NormantonNexus.Helpers.Warehouse;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Warehouse;

// UpdateAsync is the one method here that validates before ever opening a
// connection — GetByPalletAsync/CreateAsync/DeleteAsync all open a
// connection unconditionally, same caveat as most plain SQL-touching
// Helpers in this migration.
public class PalletPackagesHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    [Fact]
    public async Task UpdateAsync_rejects_a_body_with_neither_field_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            PalletPackagesHelper.UpdateAsync(db.Object, 1, new UpdatePalletPackageRequest(null, null), CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public async Task UpdateAsync_rejects_a_non_positive_palletLayer_without_opening_a_connection(int palletLayer)
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            PalletPackagesHelper.UpdateAsync(db.Object, 1, new UpdatePalletPackageRequest(palletLayer, null), CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task UpdateAsync_rejects_a_blank_packagingId_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            PalletPackagesHelper.UpdateAsync(db.Object, 1, new UpdatePalletPackageRequest(null, "   "), CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }
}
