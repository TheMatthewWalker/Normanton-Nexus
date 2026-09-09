using NormantonNexus.Helpers.Warehouse;

namespace NormantonNexus.Tests.Helpers.Warehouse;

public class RedrumReversalHelperTests
{
    // PadCostCollectorBin is pure, no I/O -- fully testable, unlike almost
    // everything else in this Helper (every other method opens a real
    // SqlConnection/calls SapServer). Mirrors Node's own padCostCollectorBin:
    // Right(x, 10) if longer than 10 characters, left-zero-padded otherwise.
    [Theory]
    [InlineData("12345", "0000012345")]
    [InlineData("1234567890", "1234567890")]
    [InlineData("123456789012", "3456789012")]
    [InlineData("", "0000000000")]
    [InlineData("  42  ", "0000000042")]
    public void PadCostCollectorBin_pads_or_truncates_to_10_characters(string raw, string expected)
    {
        Assert.Equal(expected, RedrumReversalHelper.PadCostCollectorBin(raw));
    }
}
