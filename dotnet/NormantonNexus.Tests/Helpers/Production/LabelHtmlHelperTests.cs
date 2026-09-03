using NormantonNexus.Helpers.Production;
using NormantonNexus.Models.Dto;

namespace NormantonNexus.Tests.Helpers.Production;

// Pure string-building, no DB/SAP — unlike almost everything else in this
// migration, this is fully testable for real, not just "the validation
// path before a connection opens".
public class LabelHtmlHelperTests
{
    private static LabelData SampleCompleteExtrusion() => new(
        ProcessCode: "EX", ProcessName: "Extrusion", BatchRef: "EX00000042", Status: 4,
        Material: "K-NBR-70", Machine: "EX-1", Operators: [new LabelOperatorRow(true, "jsmith", "Jane Smith")],
        CreatedAt: new DateTime(2026, 1, 5, 8, 0, 0), CompletedAt: new DateTime(2026, 1, 5, 14, 30, 0),
        Quantity: 1234.567m, Uom: "M", ParentBatches: ["MX00000001"], SapMatDoc: "5000001234",
        Notes: "Ran hot on start", SupplierBatchNo: null, SupplierTubNo: null);

    private static LabelData SampleOpenMixingTub(int tubSeq) => new(
        ProcessCode: "MX", ProcessName: "Mixing", BatchRef: $"MX00000007-T{tubSeq}", Status: 1,
        Material: "MIX-COMPOUND-1", Machine: null, Operators: [new LabelOperatorRow(true, "aoperator", "Alan Operator")],
        CreatedAt: new DateTime(2026, 1, 5, 9, 0, 0), CompletedAt: null,
        Quantity: 25.5m, Uom: "KG", ParentBatches: [], SapMatDoc: null,
        Notes: null, SupplierBatchNo: "SB-100", SupplierTubNo: $"T{tubSeq}");

    [Fact]
    public void RenderPage_includes_the_batch_reference_status_badge_and_barcode_images()
    {
        var html = LabelHtmlHelper.RenderPage([SampleCompleteExtrusion()]);

        Assert.Contains("EX00000042", html);
        Assert.Contains("COMPLETE", html);
        Assert.Contains("#0d9488", html); // COMPLETE badge colour
        Assert.Contains("data:image/png;base64,", html);
        Assert.Contains("K-NBR-70", html);
        Assert.Contains("5000001234", html); // SAP material document, only shown when complete
        Assert.Contains("Ran hot on start", html);
    }

    [Fact]
    public void RenderPage_uses_a_single_label_title_for_one_record()
    {
        var html = LabelHtmlHelper.RenderPage([SampleCompleteExtrusion()]);
        Assert.Contains("<title>EX00000042 — Extrusion Label</title>", html);
    }

    [Fact]
    public void RenderPage_omits_SAP_and_notes_sections_for_an_open_incomplete_record()
    {
        var open = SampleCompleteExtrusion() with { Status = 1, CompletedAt = null, SapMatDoc = null, Notes = null };
        var html = LabelHtmlHelper.RenderPage([open]);

        Assert.DoesNotContain("SAP MATERIAL DOCUMENT", html);
        Assert.DoesNotContain("NOTES", html);
        Assert.Contains("OPEN", html);
        Assert.Contains("CREATED", html); // not-yet-complete uses CREATED, not COMPLETED
    }

    [Fact]
    public void RenderPage_renders_one_label_div_per_tub_with_a_combined_title_for_multiple_mixing_tickets()
    {
        var tickets = new[] { SampleOpenMixingTub(1), SampleOpenMixingTub(2), SampleOpenMixingTub(3) };
        var html = LabelHtmlHelper.RenderPage(tickets);

        Assert.Equal(3, html.Split("class=\"label\"").Length - 1);
        Assert.Contains("<title>MX00000007 — Mixing Labels (3)</title>", html);
        Assert.Contains("MX00000007-T1", html);
        Assert.Contains("MX00000007-T2", html);
        Assert.Contains("MX00000007-T3", html);
        Assert.Contains("Supplier Batch: SB-100", html);
    }
}
