using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models.Dto;

namespace NormantonNexus.Tests.Helpers.Logistics;

// Same precedent as every other PDF Helper in this migration: QuestPDF's
// Document.GeneratePdf() runs for real, checked against real, verifiable
// PDF structure (the %PDF magic header, a sane byte length) rather than
// just "didn't throw" — no PDF viewer in this sandbox to check pixel
// fidelity against Node's pdfkit output.
public class ConsignmentDeclarationPdfHelperTests
{
    private static ConsignmentDeclarationLineRow Line(string material, decimal qty, string? invoice = "INV-1", string? matDoc = "5000001", DateTime? expiry = null) =>
        new(1, 200, material, qty, invoice, matDoc, new DateTime(2026, 1, 1), "KG", expiry);

    private static ConsignmentDeclarationPdfHelper.Input SampleInput() => new(
        DeclarationId: 42, VendorName: "Raaj Ratna", SapVendorNumber: "0000200604", Status: "Draft", AllocationMethod: "FEFO",
        TotalQty: 150m, CreatedAtUtc: new DateTime(2026, 3, 1), SettlementDocumentNumber: null,
        MaterialSummaries: [new DeclarationMaterialSummary("MAT001", 500m, 100m, 150m, 350m)],
        Lines: [Line("MAT001", 100m, expiry: new DateTime(2026, 6, 1)), Line("MAT001", 50m, expiry: new DateTime(2026, 7, 1))]);

    [Fact]
    public void Build_produces_a_valid_PDF_with_a_material_summary_and_lines()
    {
        var bytes = ConsignmentDeclarationPdfHelper.Build(SampleInput());

        Assert.True(bytes.Length > 500);
        Assert.Equal("%PDF"u8.ToArray(), bytes[..4]);
    }

    [Fact]
    public void Build_does_not_throw_with_no_material_summaries_and_no_lines()
    {
        var input = SampleInput() with { MaterialSummaries = [], Lines = [] };

        var bytes = ConsignmentDeclarationPdfHelper.Build(input);

        Assert.True(bytes.Length > 200);
    }

    [Fact]
    public void Build_handles_multiple_material_groups()
    {
        var input = SampleInput() with
        {
            Lines = [Line("MAT001", 100m), Line("MAT002", 75m, invoice: "INV-2", matDoc: "5000002")],
        };

        var bytes = ConsignmentDeclarationPdfHelper.Build(input);

        Assert.True(bytes.Length > 500);
        Assert.Equal("%PDF"u8.ToArray(), bytes[..4]);
    }

    [Fact]
    public void Build_does_not_throw_when_settlement_document_is_present()
    {
        var input = SampleInput() with { Status = "Confirmed", SettlementDocumentNumber = "1700003535" };

        var bytes = ConsignmentDeclarationPdfHelper.Build(input);

        Assert.True(bytes.Length > 500);
    }
}
