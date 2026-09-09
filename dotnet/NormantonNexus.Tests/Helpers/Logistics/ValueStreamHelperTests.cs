using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models.Dto;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class ValueStreamHelperTests
{
    [Theory]
    [InlineData("2000", "PTFE")]
    [InlineData("2008", "PV")]
    [InlineData("9912", "PTFE")]
    public void MapProfitCentreToValueStream_maps_a_bare_profit_centre(string profitCentre, string expected)
    {
        Assert.Equal(expected, ValueStreamHelper.MapProfitCentreToValueStream(profitCentre));
    }

    [Fact]
    public void MapProfitCentreToValueStream_strips_leading_zeros_before_mapping()
    {
        Assert.Equal("PV", ValueStreamHelper.MapProfitCentreToValueStream("0000002008"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("9999")]
    public void MapProfitCentreToValueStream_returns_null_for_blank_or_unmapped_centres(string? profitCentre)
    {
        Assert.Null(ValueStreamHelper.MapProfitCentreToValueStream(profitCentre));
    }

    [Fact]
    public void EnrichWithValueStream_stamps_ValueStream_on_stock_rows_from_ProfitCentre()
    {
        var rows = new[] { new SapPerformanceStockRow { Material = "M1", ProfitCentre = "2008" } };

        ValueStreamHelper.EnrichWithValueStream(rows);

        Assert.Equal("PV", rows[0].ValueStream);
    }

    [Fact]
    public void EnrichWithValueStream_stamps_null_on_agreement_rows_with_an_unmapped_centre()
    {
        var rows = new[] { new SapAgreementRow { Material = "M1", ReferenceDocument = "SO1", ProfitCentre = "9999" } };

        ValueStreamHelper.EnrichWithValueStream(rows);

        Assert.Null(rows[0].ValueStream);
    }

    [Fact]
    public void ComputeTodayStockAndPickedTotals_sums_stock_and_picked_value_by_value_stream()
    {
        var rows = new[]
        {
            new SapAgreementRow { Material = "M1", ReferenceDocument = "SO1", ValueStream = "PTFE", OrderQty = 100m, LocalAmount = 500m, DockStockAllocated = 20m, PickedStockAllocated = 10m },
            new SapAgreementRow { Material = "M2", ReferenceDocument = "SO2", ValueStream = "PTFE", OrderQty = 50m, LocalAmount = 250m, DockStockAllocated = 5m, PickedStockAllocated = 0m },
        };

        var totals = ValueStreamHelper.ComputeTodayStockAndPickedTotals(rows);

        // unitPrice = 500/100 = 5 -> stock 20*5=100, picked 10*5=50
        // unitPrice = 250/50 = 5 -> stock 5*5=25, picked 0
        Assert.Equal(125m, totals["PTFE"].StockValue);
        Assert.Equal(50m, totals["PTFE"].PickedValue);
    }

    [Fact]
    public void ComputeTodayStockAndPickedTotals_buckets_a_row_with_no_ValueStream_under_UNKNOWN()
    {
        var rows = new[] { new SapAgreementRow { Material = "M1", ReferenceDocument = "SO1", ValueStream = null, OrderQty = 10m, LocalAmount = 100m, DockStockAllocated = 5m } };

        var totals = ValueStreamHelper.ComputeTodayStockAndPickedTotals(rows);

        Assert.True(totals.ContainsKey("UNKNOWN"));
    }

    [Fact]
    public void ComputeTodayStockAndPickedTotals_treats_a_zero_OrderQty_as_zero_unit_price_rather_than_dividing_by_zero()
    {
        var rows = new[] { new SapAgreementRow { Material = "M1", ReferenceDocument = "SO1", ValueStream = "PTFE", OrderQty = 0m, LocalAmount = 100m, DockStockAllocated = 5m } };

        var totals = ValueStreamHelper.ComputeTodayStockAndPickedTotals(rows);

        Assert.False(totals.ContainsKey("PTFE")); // amount is 0 (5 * 0) -> never added
    }
}
