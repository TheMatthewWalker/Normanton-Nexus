using NormantonNexus.Helpers.Logistics;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class UnitConversionHelperTests
{
    [Fact]
    public void ConvertQty_returns_the_same_value_when_units_match()
    {
        Assert.Equal(100m, UnitConversionHelper.ConvertQty(100m, "KG", "KG"));
    }

    [Fact]
    public void ConvertQty_converts_KG_to_LB()
    {
        var result = UnitConversionHelper.ConvertQty(1m, "KG", "LB");
        Assert.Equal(1m / 0.45359237m, result, 6);
    }

    [Fact]
    public void ConvertQty_converts_LB_to_KG()
    {
        var result = UnitConversionHelper.ConvertQty(1m, "LB", "KG");
        Assert.Equal(0.45359237m, result);
    }

    [Fact]
    public void ConvertQty_defaults_null_units_to_KG()
    {
        Assert.Equal(5m, UnitConversionHelper.ConvertQty(5m, null, null));
    }

    [Fact]
    public void ConvertQty_is_case_insensitive()
    {
        var result = UnitConversionHelper.ConvertQty(1m, "kg", "lb");
        Assert.Equal(1m / 0.45359237m, result, 6);
    }

    [Fact]
    public void ConvertQty_throws_for_an_unsupported_unit()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => UnitConversionHelper.ConvertQty(1m, "KG", "TONNE"));
        Assert.Contains("Unsupported unit conversion", ex.Message);
    }
}
