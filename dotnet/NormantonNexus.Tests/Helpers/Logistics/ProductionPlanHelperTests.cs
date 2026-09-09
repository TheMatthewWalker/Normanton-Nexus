using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models.Dto;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class ProductionPlanHelperTests
{
    private static OrderBookBreakdownRow Row(string refDoc, string material, string valueStream = "PTFE", decimal orderQty = 100m, decimal orderValue = 500m, string? customer = "0001234", string? customerName = "Acme Ltd") =>
        new(valueStream, customer, customerName, refDoc, material, "Some Material", "2026-09-05", orderQty, orderValue, 0m, 0m, 0m, 0m);

    [Fact]
    public void BuildPlanFromRows_excludes_lines_not_flagged_LastDay()
    {
        var rows = new[] { Row("SO1", "M1") };
        var notes = new Dictionary<string, OrderBookLineNote> { ["SO1||M1"] = new(null, null, null, null, null, null, null) };

        var plan = ProductionPlanHelper.BuildPlanFromRows(rows, notes);

        Assert.Empty(plan);
    }

    [Fact]
    public void BuildPlanFromRows_excludes_lines_flagged_WontGet_even_if_LastDay_is_set()
    {
        var rows = new[] { Row("SO1", "M1") };
        var notes = new Dictionary<string, OrderBookLineNote> { ["SO1||M1"] = new(null, null, "x", "x", "09:00", null, null) };

        var plan = ProductionPlanHelper.BuildPlanFromRows(rows, notes);

        Assert.Empty(plan);
    }

    [Fact]
    public void BuildPlanFromRows_excludes_non_PTFE_value_streams()
    {
        var rows = new[] { Row("SO1", "M1", valueStream: "PV") };
        var notes = new Dictionary<string, OrderBookLineNote> { ["SO1||M1"] = new(null, null, null, "x", "09:00", null, null) };

        var plan = ProductionPlanHelper.BuildPlanFromRows(rows, notes);

        Assert.Empty(plan);
    }

    [Fact]
    public void BuildPlanFromRows_includes_a_line_flagged_LastDay_and_not_WontGet()
    {
        var rows = new[] { Row("SO1", "M1", orderQty: 100m, orderValue: 500m) };
        var notes = new Dictionary<string, OrderBookLineNote> { ["SO1||M1"] = new(null, null, null, "x", "09:00", null, null) };

        var plan = ProductionPlanHelper.BuildPlanFromRows(rows, notes);

        var line = Assert.Single(plan);
        Assert.Equal("09:00", line.Time);
        Assert.Equal("Acme Ltd", line.Customer);
        Assert.Equal(100m, line.Quantity); // no PlannedProductionQty override -> falls back to OrderQty
        Assert.Equal(500m, line.Value);
    }

    [Fact]
    public void BuildPlanFromRows_uses_PlannedProductionQty_override_and_scales_value_proportionally()
    {
        var rows = new[] { Row("SO1", "M1", orderQty: 100m, orderValue: 500m) };
        var notes = new Dictionary<string, OrderBookLineNote> { ["SO1||M1"] = new(null, null, null, "x", "09:00", null, 40m) };

        var plan = ProductionPlanHelper.BuildPlanFromRows(rows, notes);

        var line = Assert.Single(plan);
        Assert.Equal(40m, line.Quantity);
        Assert.Equal(200m, line.Value); // 40 * (500/100)
    }

    [Fact]
    public void BuildPlanFromRows_treats_a_zero_OrderQty_as_zero_value_rather_than_dividing_by_zero()
    {
        var rows = new[] { Row("SO1", "M1", orderQty: 0m, orderValue: 500m) };
        var notes = new Dictionary<string, OrderBookLineNote> { ["SO1||M1"] = new(null, null, null, "x", "09:00", null, 10m) };

        var plan = ProductionPlanHelper.BuildPlanFromRows(rows, notes);

        Assert.Equal(0m, Assert.Single(plan).Value);
    }

    [Fact]
    public void BuildPlanFromRows_a_line_missing_from_the_notes_map_is_excluded()
    {
        var rows = new[] { Row("SO1", "M1") };
        var notes = new Dictionary<string, OrderBookLineNote>();

        var plan = ProductionPlanHelper.BuildPlanFromRows(rows, notes);

        Assert.Empty(plan);
    }

    [Fact]
    public void BuildPlanFromRows_falls_back_to_Customer_when_CustomerName_is_null()
    {
        var rows = new[] { Row("SO1", "M1", customerName: null) };
        var notes = new Dictionary<string, OrderBookLineNote> { ["SO1||M1"] = new(null, null, null, "x", "09:00", null, null) };

        var plan = ProductionPlanHelper.BuildPlanFromRows(rows, notes);

        Assert.Equal("0001234", Assert.Single(plan).Customer);
    }

    [Fact]
    public void BuildPlanFromRows_sorts_by_LastDayTime_ascending()
    {
        var rows = new[] { Row("SO1", "M1"), Row("SO2", "M2"), Row("SO3", "M3") };
        var notes = new Dictionary<string, OrderBookLineNote>
        {
            ["SO1||M1"] = new(null, null, null, "x", "15:00", null, null),
            ["SO2||M2"] = new(null, null, null, "x", "09:00", null, null),
            ["SO3||M3"] = new(null, null, null, "x", "", null, null), // blank sorts first
        };

        var plan = ProductionPlanHelper.BuildPlanFromRows(rows, notes);

        Assert.Equal(["", "09:00", "15:00"], plan.Select(p => p.Time));
    }

    // ── ParseLastDayTimeMinutes ────────────────────────────────────────────

    [Theory]
    [InlineData("15:00", 900)]
    [InlineData("09:05", 545)]
    [InlineData("0:00", 0)]
    public void ParseLastDayTimeMinutes_parses_HMM_prefixed_text(string text, int expected)
    {
        Assert.Equal(expected, ProductionPlanHelper.ParseLastDayTimeMinutes(text));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("TBC")]
    [InlineData("AM")]
    public void ParseLastDayTimeMinutes_sorts_unparseable_text_first(string? text)
    {
        Assert.Equal(-1, ProductionPlanHelper.ParseLastDayTimeMinutes(text));
    }

    // ── BuildHtml ────────────────────────────────────────────────────────

    [Fact]
    public void BuildHtml_shows_the_empty_state_when_nothing_is_flagged()
    {
        var html = ProductionPlanHelper.BuildHtml([]);

        Assert.Contains("Nothing is currently flagged Last Day", html);
        Assert.DoesNotContain("<tfoot>", html);
    }

    [Fact]
    public void BuildHtml_HTML_encodes_customer_and_material_text()
    {
        var plan = new[] { new ProductionPlanLine("09:00", "Acme <script> Ltd", "M1", "R&D Grade", 10m, 50m) };

        var html = ProductionPlanHelper.BuildHtml(plan);

        Assert.Contains("Acme &lt;script&gt; Ltd", html);
        Assert.Contains("R&amp;D Grade", html);
        Assert.DoesNotContain("Acme <script> Ltd", html);
    }

    [Fact]
    public void BuildHtml_includes_a_totals_footer_when_lines_are_present()
    {
        var plan = new[]
        {
            new ProductionPlanLine("09:00", "Acme Ltd", "M1", null, 10m, 50m),
            new ProductionPlanLine("10:00", "Beta Ltd", "M2", null, 5m, 25m),
        };

        var html = ProductionPlanHelper.BuildHtml(plan);

        Assert.Contains("<tfoot>", html);
        Assert.Contains("15", html); // total qty
        Assert.Contains("£75.00", html); // total value
    }
}
