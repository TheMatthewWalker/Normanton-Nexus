using NormantonNexus.Helpers.Warehouse;

namespace NormantonNexus.Tests.Helpers.Warehouse;

public class WarehouseSapSyncHelperTests
{
    // ── ParseLeadingLong ───────────────────────────────────────────────
    // Mirrors JS's parseInt(str, 10) leniency (leading digits only).

    [Theory]
    [InlineData("12345", 12345)]
    [InlineData("  789  ", 789)]
    [InlineData("42abc", 42)] // trailing garbage tolerated, matching parseInt
    [InlineData("-7", -7)]
    public void ParseLeadingLong_parses_leading_digits_leniently(string raw, long expected)
    {
        Assert.Equal(expected, WarehouseSapSyncHelper.ParseLeadingLong(raw));
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("abc")]
    [InlineData("   ")]
    public void ParseLeadingLong_returns_null_for_non_numeric_input(string? raw)
    {
        Assert.Null(WarehouseSapSyncHelper.ParseLeadingLong(raw));
    }

    // ── ParseSapDate ───────────────────────────────────────────────────

    [Fact]
    public void ParseSapDate_parses_DD_dot_MM_dot_YYYY()
    {
        Assert.Equal(new DateTime(2026, 3, 15), WarehouseSapSyncHelper.ParseSapDate("15.03.2026"));
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("not-a-date")]
    [InlineData("2026-03-15")]
    [InlineData("32.13.2026")]
    public void ParseSapDate_returns_null_for_unparseable_or_invalid_input(string? raw)
    {
        Assert.Null(WarehouseSapSyncHelper.ParseSapDate(raw));
    }

    // ── NullIfBlank ────────────────────────────────────────────────────

    [Theory]
    [InlineData("  hello  ", "hello")]
    [InlineData("", null)]
    [InlineData("   ", null)]
    [InlineData(null, null)]
    public void NullIfBlank_trims_or_returns_null(string? raw, string? expected)
    {
        Assert.Equal(expected, WarehouseSapSyncHelper.NullIfBlank(raw));
    }
}
