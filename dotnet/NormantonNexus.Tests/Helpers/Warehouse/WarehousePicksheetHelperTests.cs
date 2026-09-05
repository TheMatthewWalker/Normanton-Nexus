using Moq;
using NormantonNexus.Helpers.Warehouse;
using NormantonNexus.Models;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Warehouse;

public class WarehousePicksheetHelperTests
{
    // ParseSapQuantity is pure, no I/O — fully testable, unlike almost
    // everything else SAP/SQL-facing in this migration. Verifies the
    // last-separator-wins algorithm this deliberately uses INSTEAD of
    // Node's own parseSapNum (which assumes every value lacking a comma is
    // European-grouped and strips the period) — see the method's own doc
    // comment for why that assumption is confirmed wrong for this SAP
    // system's mixed-format data (SapServer/CLAUDE.md's decimal-parsing
    // bug writeup).
    [Theory]
    [InlineData("10.875,000", 10875)]      // European-grouped: comma is the real decimal point
    [InlineData("1234,56", 1234.56)]       // comma-only European decimal
    [InlineData("1234.56", 1234.56)]       // plain invariant decimal -- Node's own parseSapNum would wrongly strip this to 123456
    [InlineData("1234", 1234)]             // plain integer, no separators at all
    [InlineData("1,234.56", 1234.56)]      // US-grouped: period is the real decimal point
    [InlineData("", 0)]
    [InlineData(null, 0)]
    [InlineData("not-a-number", 0)]
    public void ParseSapQuantity_resolves_the_real_decimal_point_per_value(string? raw, decimal expected)
    {
        Assert.Equal(expected, WarehousePicksheetHelper.ParseSapQuantity(raw));
    }

    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    [Fact]
    public async Task LinkSearchAsync_rejects_a_missing_excludeDeliveryId_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            WarehousePicksheetHelper.LinkSearchAsync(db.Object, null, "q", CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }
}
