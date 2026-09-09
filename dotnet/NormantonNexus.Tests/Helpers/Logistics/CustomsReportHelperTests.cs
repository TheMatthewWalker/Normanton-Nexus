using ClosedXML.Excel;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class CustomsReportHelperTests
{
    // ── Digits ─────────────────────────────────────────────────────────

    [Theory]
    [InlineData("0082892007", "82892007")]
    [InlineData("82892007", "82892007")]
    [InlineData("0000000000", "0")]
    [InlineData("", "")]
    [InlineData(null, "")]
    [InlineData("ABC123", "ABC123")] // not purely numeric — returned unchanged
    [InlineData("  0042  ", "42")]
    public void Digits_strips_leading_zeros_from_a_purely_numeric_id(string? raw, string expected)
    {
        Assert.Equal(expected, CustomsReportHelper.Digits(raw));
    }

    // ── ParseSapDate ───────────────────────────────────────────────────

    [Theory]
    [InlineData("15.03.2026", 2026, 3, 15)]
    [InlineData("20260315", 2026, 3, 15)]
    public void ParseSapDate_parses_both_SAP_date_shapes(string raw, int year, int month, int day)
    {
        Assert.Equal(new DateTime(year, month, day), CustomsReportHelper.ParseSapDate(raw));
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("not-a-date")]
    [InlineData("00.00.0000")]
    [InlineData("00000000")]
    public void ParseSapDate_returns_null_for_unparseable_or_zero_input(string? raw)
    {
        Assert.Null(CustomsReportHelper.ParseSapDate(raw));
    }

    // ── ParseSapNumber ─────────────────────────────────────────────────
    // Faithful port of Node's own parseSapNumber — always assumes European
    // grouping (strip "." then swap "," for "."), same known-limitation
    // precedent as ClearPortShipmentPayloadHelper.ParseEuropeanDecimal.

    [Theory]
    [InlineData("2.748,000", 2748)]
    [InlineData("1234,56", 1234.56)]
    [InlineData("1234", 1234)]
    [InlineData("", 0)]
    [InlineData(null, 0)]
    [InlineData("not-a-number", 0)]
    public void ParseSapNumber_strips_thousands_separators_and_swaps_the_decimal_comma(string? raw, decimal expected)
    {
        Assert.Equal(expected, CustomsReportHelper.ParseSapNumber(raw));
    }

    // ── ApportionWeights ───────────────────────────────────────────────
    // Replicates ROUND(SUMIFS(weight, delivery) / SUMIFS(qty, delivery) * lineQty, 2).

    private static CustomsReportRow Row(string delivery, string item, decimal qty) => new()
    {
        DeliveryNumber = delivery, ItemNumber = item, Material = "M1", Quantity = qty, ConsigneeCode = "C1",
    };

    [Fact]
    public void ApportionWeights_splits_delivery_weight_proportionally_to_line_quantity()
    {
        var rows = new List<CustomsReportRow> { Row("100", "10", 60m), Row("100", "20", 40m) };
        var weightByDelivery = new Dictionary<string, decimal> { ["100"] = 500m };

        CustomsReportHelper.ApportionWeights(rows, weightByDelivery);

        Assert.Equal(300m, rows[0].Weight); // 500/100 * 60
        Assert.Equal(200m, rows[1].Weight); // 500/100 * 40
    }

    [Fact]
    public void ApportionWeights_rounds_to_2_decimal_places()
    {
        var rows = new List<CustomsReportRow> { Row("200", "10", 1m), Row("200", "20", 2m) };
        var weightByDelivery = new Dictionary<string, decimal> { ["200"] = 10m };

        CustomsReportHelper.ApportionWeights(rows, weightByDelivery);

        Assert.Equal(3.33m, rows[0].Weight); // 10/3 * 1 = 3.3333...
        Assert.Equal(6.67m, rows[1].Weight); // 10/3 * 2 = 6.6666...
    }

    [Fact]
    public void ApportionWeights_leaves_weight_null_when_total_quantity_is_zero()
    {
        var rows = new List<CustomsReportRow> { Row("300", "10", 0m) };
        var weightByDelivery = new Dictionary<string, decimal> { ["300"] = 50m };

        CustomsReportHelper.ApportionWeights(rows, weightByDelivery);

        Assert.Null(rows[0].Weight);
    }

    [Fact]
    public void ApportionWeights_treats_a_delivery_missing_from_the_weight_map_as_zero()
    {
        var rows = new List<CustomsReportRow> { Row("400", "10", 5m) };
        var weightByDelivery = new Dictionary<string, decimal>();

        CustomsReportHelper.ApportionWeights(rows, weightByDelivery);

        Assert.Equal(0m, rows[0].Weight);
    }

    // ── ParseShipmentsUpload ───────────────────────────────────────────

    private static byte[] BuildUpload(string[] headers, IEnumerable<object?[]> rows, string sheetName = "Shipments")
    {
        using var wb = new XLWorkbook();
        var ws = wb.Worksheets.Add(sheetName);
        for (var i = 0; i < headers.Length; i++) ws.Cell(1, i + 1).Value = headers[i];
        var r = 2;
        foreach (var row in rows)
        {
            for (var c = 0; c < row.Length; c++)
            {
                var cell = ws.Cell(r, c + 1);
                switch (row[c])
                {
                    case DateTime dt: cell.Value = dt; break;
                    case decimal dec: cell.Value = dec; break;
                    case int i2: cell.Value = i2; break;
                    case string s: cell.Value = s; break;
                }
            }
            r++;
        }
        using var stream = new MemoryStream();
        wb.SaveAs(stream);
        return stream.ToArray();
    }

    [Fact]
    public void ParseShipmentsUpload_parses_rows_from_the_Shipments_sheet()
    {
        var bytes = BuildUpload(
            ["PicksheetNumber", "ShipmentRef", "ActualCollectionDate", "TotalWeight"],
            [["82892007", "REF1", new DateTime(2026, 3, 1), 123.45m]]);

        var rows = CustomsReportHelper.ParseShipmentsUpload(bytes);

        Assert.Single(rows);
        Assert.Equal("82892007", rows[0].PicksheetNumber);
        Assert.Equal("REF1", rows[0].ShipmentRef);
        Assert.Equal(new DateTime(2026, 3, 1), rows[0].ActualCollectionDate);
        Assert.Equal(123.45m, rows[0].TotalWeight);
    }

    [Fact]
    public void ParseShipmentsUpload_falls_back_to_the_first_sheet_when_none_is_named_Shipments()
    {
        var bytes = BuildUpload(
            ["PicksheetNumber", "ShipmentRef", "ActualCollectionDate", "TotalWeight"],
            [["123", "REF2", null, 10m]], sheetName: "Sheet1");

        var rows = CustomsReportHelper.ParseShipmentsUpload(bytes);

        Assert.Single(rows);
        Assert.Equal("123", rows[0].PicksheetNumber);
    }

    [Fact]
    public void ParseShipmentsUpload_skips_rows_with_no_picksheetNumber()
    {
        var bytes = BuildUpload(
            ["PicksheetNumber", "ShipmentRef", "ActualCollectionDate", "TotalWeight"],
            [["", "REF1", null, 10m], ["456", "REF2", null, 20m]]);

        var rows = CustomsReportHelper.ParseShipmentsUpload(bytes);

        Assert.Single(rows);
        Assert.Equal("456", rows[0].PicksheetNumber);
    }

    [Fact]
    public void ParseShipmentsUpload_throws_a_validation_exception_when_a_required_column_is_missing()
    {
        var bytes = BuildUpload(["PicksheetNumber", "ShipmentRef"], [["123", "REF1"]]);

        var ex = Assert.Throws<NexusValidationException>(() => CustomsReportHelper.ParseShipmentsUpload(bytes));
        Assert.Contains("ActualCollectionDate", ex.Message);
        Assert.Contains("TotalWeight", ex.Message);
    }
}
