using NormantonNexus.Helpers.Production;
using NormantonNexus.Models.Dto;

namespace NormantonNexus.Tests.Helpers.Production;

// QuestPDF's Document.GeneratePdf() runs for real here (pure managed, no
// OS/printer dependency) — these tests actually generate PDF bytes and
// check real, verifiable structure (the %PDF magic header, page count via
// counting "/Type /Page" object entries), not just "didn't throw". See
// LabelPdfHelper.cs's doc comment for why this isn't chasing pixel-for-
// pixel fidelity against Node's PDFKit output.
public class LabelPdfHelperTests
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

    private static int CountPdfPages(byte[] pdfBytes)
    {
        var text = System.Text.Encoding.Latin1.GetString(pdfBytes);
        return System.Text.RegularExpressions.Regex.Matches(text, @"/Type\s*/Page[^s]").Count;
    }

    [Theory]
    [InlineData("A5")]
    [InlineData("A4")]
    public void BuildSingleLabelPdf_produces_a_valid_one_page_PDF_for_both_paper_sizes(string paperSize)
    {
        var bytes = LabelPdfHelper.BuildSingleLabelPdf(SampleCompleteExtrusion(), paperSize);

        Assert.True(bytes.Length > 500);
        Assert.Equal("%PDF"u8.ToArray(), bytes[..4]);
        Assert.Equal(1, CountPdfPages(bytes));
    }

    [Fact]
    public void BuildLabelsPdf_produces_one_page_per_mixing_tub()
    {
        var tickets = new[] { SampleOpenMixingTub(1), SampleOpenMixingTub(2), SampleOpenMixingTub(3) };
        var bytes = LabelPdfHelper.BuildLabelsPdf(tickets, "A5");

        Assert.Equal(3, CountPdfPages(bytes));
    }

    [Fact]
    public void BuildSingleLabelPdf_does_not_throw_for_an_open_record_with_no_machine_or_sap_document()
    {
        var open = SampleCompleteExtrusion() with { Status = 1, CompletedAt = null, SapMatDoc = null, Notes = null, Machine = null };
        var bytes = LabelPdfHelper.BuildSingleLabelPdf(open, "A5");

        Assert.True(bytes.Length > 500);
    }
}
