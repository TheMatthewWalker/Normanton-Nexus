using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class ShipmentHelperTests
{
    [Theory]
    [InlineData(1, "00000001")]
    [InlineData(1234567, "01234567")]
    [InlineData(123456789, "123456789")] // longer than 8 digits -- padding has no effect, matches Node's String.padStart
    public void FormatShipmentRef_zero_pads_to_8_digits(long shipmentId, string expected)
    {
        Assert.Equal(expected, ShipmentHelper.FormatShipmentRef(shipmentId));
    }

    [Theory]
    [InlineData("EXW", true)]
    [InlineData("exw", true)]
    [InlineData(" Exw ", true)]
    [InlineData("EX WORKS", true)]
    [InlineData("ex works", true)]
    [InlineData("DAP", false)]
    [InlineData(null, false)]
    [InlineData("", false)]
    public void IsExWorks_matches_EXW_or_EX_WORKS_case_insensitively(string? incoTerms, bool expected)
    {
        Assert.Equal(expected, ShipmentHelper.IsExWorks(incoTerms));
    }

    [Theory]
    [InlineData(null, "Unknown Customer")]
    [InlineData("", "Unknown Customer")]
    [InlineData("Acme Ltd", "Acme Ltd")]
    [InlineData("Acme/Ltd:Co*", "Acme_Ltd_Co_")]
    [InlineData("Acme Ltd.", "Acme Ltd")]
    [InlineData("Acme Ltd   ", "Acme Ltd")]
    public void SanitizeFolderSegment_strips_illegal_path_characters_and_trailing_dots_or_spaces(string? value, string expected)
    {
        Assert.Equal(expected, ShipmentHelper.SanitizeFolderSegment(value));
    }

    [Theory]
    [InlineData(@"C:\exports\customer-invoices", true)]
    [InlineData(@"D:/exports", true)]
    [InlineData(@"\\fileserver\share\exports", true)]
    [InlineData("exports/customer-invoices", false)] // relative path -- not a real Windows absolute path
    [InlineData("", false)]
    public void AssertValidExportRoot_requires_a_real_absolute_Windows_or_UNC_path(string value, bool valid)
    {
        if (valid)
        {
            Assert.Equal(value.Trim(), ShipmentHelper.AssertValidExportRoot(value));
        }
        else
        {
            Assert.Throws<NexusBadGatewayException>(() => ShipmentHelper.AssertValidExportRoot(value));
        }
    }

    [Fact]
    public void GetShipmentFolderInfo_builds_customer_and_shipment_paths_under_the_export_root()
    {
        var settings = new LogisticsOptions { ExportRoot = @"C:\exports\customer-invoices" };
        var shipment = new ShipmentRow(
            42, null, null, null, null, null, null,
            null, "Acme/Ltd", null, null, null, null,
            null, null, null, null,
            null, null, false,
            null, null, null, false, false, false,
            null, null, false, false, null, false,
            null, null, null);

        var folder = ShipmentHelper.GetShipmentFolderInfo(shipment, settings);

        Assert.Equal("00000042", folder.ShipmentRef);
        Assert.Equal(Path.Combine(@"C:\exports\customer-invoices", "Acme_Ltd"), folder.CustomerPath);
        Assert.Equal(Path.Combine(@"C:\exports\customer-invoices", "Acme_Ltd", "00000042"), folder.ShipmentPath);
    }
}
