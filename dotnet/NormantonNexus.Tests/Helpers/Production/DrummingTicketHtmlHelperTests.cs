using NormantonNexus.Helpers.Production;
using NormantonNexus.Models.Dto;

namespace NormantonNexus.Tests.Helpers.Production;

// Pure string-building, no DB/SAP — same as LabelHtmlHelperTests, fully
// testable for real rather than just "the validation path before a
// connection opens".
public class DrummingTicketHtmlHelperTests
{
    private static DrummingTicketData Sample(string? sapInstructions = "Handle with care", string? customerInstructions = "Standard KA packaging") => new(
        Line: new AgreementLookupRow(
            Customer: "C0001", CustomerName: "Acme Corp", ReferenceDocument: "4500012345", Item: "000010",
            Material: "HOSE-ASSY-1", MaterialText: "1/2in Braided Hose", CustomerMaterial: "ACME-HOSE-42",
            ValueStream: "VS1", RequestDate: new DateTime(2026, 3, 1), OrderQty: 500m, Uom: "M",
            StockQty: 100m, RequiredQty: 400m),
        CustomerStandardInstructions: customerInstructions ?? "",
        SapInstructions: sapInstructions ?? "");

    [Fact]
    public void RenderPage_includes_the_order_reference_and_customer_material_details()
    {
        var html = DrummingTicketHtmlHelper.RenderPage(Sample());

        Assert.Contains("4500012345-000010", html);
        Assert.Contains("C0001", html);
        Assert.Contains("Acme Corp", html);
        Assert.Contains("HOSE-ASSY-1", html);
        Assert.Contains("ACME-HOSE-42", html);
        Assert.Contains("400", html); // RequiredQty
        Assert.Contains("Handle with care", html);
        Assert.Contains("Standard KA packaging", html);
    }

    [Fact]
    public void RenderPage_shows_a_placeholder_when_SAP_or_customer_instructions_are_empty()
    {
        var html = DrummingTicketHtmlHelper.RenderPage(Sample(sapInstructions: "", customerInstructions: ""));

        Assert.Contains("No special instructions held against this order in SAP.", html);
        Assert.Contains("No standard instructions held for this customer.", html);
    }

    [Fact]
    public void RenderPage_renders_all_35_numbered_coil_checklist_rows_across_3_columns()
    {
        var html = DrummingTicketHtmlHelper.RenderPage(Sample());

        Assert.Equal(3, html.Split("coil-grid\"").Length - 1);
        for (var i = 1; i <= 35; i++)
        {
            Assert.Contains($"<td class=\"num\">{i}</td>", html);
        }
    }

    [Fact]
    public void RenderPage_html_encodes_customer_and_material_text()
    {
        var html = DrummingTicketHtmlHelper.RenderPage(Sample() with
        {
            Line = Sample().Line with { CustomerName = "R&D <Special>" }
        });

        Assert.Contains("R&amp;D &lt;Special&gt;", html);
        Assert.DoesNotContain("R&D <Special>", html);
    }
}
