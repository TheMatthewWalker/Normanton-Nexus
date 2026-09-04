using NormantonNexus.Models.Dto;
using QuestPDF.Fluent;
using QuestPDF.Helpers;
using QuestPDF.Infrastructure;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Consignment declaration PDF — Logistics Sub-phase 8e.2. Port of
/// lib/consignmentDeclarationPdf.js's buildConsignmentDeclarationPdf: the
/// printable declaration sent to a consignment vendor showing exactly
/// which delivery line/invoice/batch a declaration run allocates
/// consumption against — the matrix Raaj's old workbook always showed
/// after the fact via MRKO, produced here before MRKO is even run.
///
/// Same "deliberate non-pixel-perfect, QuestPDF-idiomatic re-layout"
/// precedent as every other PDF Helper in this migration (LabelPdfHelper,
/// ShipmentPackingListPdfHelper) — QuestPDF's own automatic pagination
/// replaces Node's manual ensureSpace()/buffered-page-footer-loop
/// machinery; same content, section grouping (header band, supplier/date/
/// status info blocks, stock summary table, per-material delivery matrix
/// with a section band + subtotal row, total, footer), different layout
/// engine.
/// </summary>
internal static class ConsignmentDeclarationPdfHelper
{
    static ConsignmentDeclarationPdfHelper()
    {
        QuestPDF.Settings.License = LicenseType.Community;
    }

    private const string Teal = "#0d4c45";
    private const string Ink = "#111827";
    private const string MutedLabel = "#6b7280";
    private const string PanelGrey = "#f3f4f6";
    private const string SubtotalPanel = "#f9fafb";
    private const string DividerColor = "#e5e7eb";
    private const string KongsbergName = "Kongsberg Actuation System Ltd";

    internal sealed record Input(
        long DeclarationId, string VendorName, string? SapVendorNumber, string Status, string AllocationMethod, decimal TotalQty,
        DateTime CreatedAtUtc, string? SettlementDocumentNumber,
        IReadOnlyList<DeclarationMaterialSummary> MaterialSummaries, IReadOnlyList<ConsignmentDeclarationLineRow> Lines);

    internal static byte[] Build(Input data)
    {
        var document = Document.Create(container =>
        {
            container.Page(page =>
            {
                page.Size(PageSizes.A4);
                page.Margin(28, Unit.Point);
                page.DefaultTextStyle(t => t.FontColor(Ink));

                page.Header().Element(c => DrawHeader(c, data));
                page.Content().PaddingTop(14).Element(c => DrawBody(c, data));
                page.Footer().Element(DrawFooter);
            });
        });

        return document.GeneratePdf();
    }

    private static void DrawHeader(IContainer container, Input data)
    {
        container.Column(col =>
        {
            col.Item().Background(Teal).Padding(12).Row(row =>
            {
                row.RelativeItem().Text("KONGSBERG AUTOMOTIVE").FontSize(15).Bold().FontColor(Colors.White);
                row.RelativeItem().AlignRight().Column(c =>
                {
                    c.Item().AlignRight().Text("CONSIGNMENT DECLARATION").FontSize(14).Bold().FontColor(Colors.White);
                    c.Item().AlignRight().Text($"Declaration #{data.DeclarationId}").FontSize(9).FontColor(Colors.White);
                });
            });

            col.Item().PaddingTop(10).Row(row =>
            {
                row.Spacing(20);
                row.RelativeItem().Column(c =>
                {
                    LabelValue(c, "Supplier", data.VendorName);
                    if (!string.IsNullOrWhiteSpace(data.SapVendorNumber))
                        LabelValue(c, "SAP Vendor", data.SapVendorNumber);
                });
                row.RelativeItem().Column(c =>
                {
                    LabelValue(c, "Declaration Date", FmtDate(data.CreatedAtUtc));
                    LabelValue(c, "Allocation Method", data.AllocationMethod);
                });
                row.RelativeItem().Column(c =>
                {
                    LabelValue(c, "Status", data.Status);
                    if (!string.IsNullOrWhiteSpace(data.SettlementDocumentNumber))
                        LabelValue(c, "SAP Settlement Doc", data.SettlementDocumentNumber);
                });
            });

            col.Item().PaddingTop(10).BorderBottom(1.5f).BorderColor(Teal);
        });
    }

    private static void LabelValue(ColumnDescriptor col, string label, string value)
    {
        col.Item().PaddingBottom(6).Column(c =>
        {
            c.Item().Text(label.ToUpperInvariant()).FontSize(7.5f).Bold().FontColor(MutedLabel);
            c.Item().Text(value).FontSize(9.5f);
        });
    }

    private static void DrawBody(IContainer container, Input data)
    {
        container.Column(col =>
        {
            if (data.MaterialSummaries.Count > 0)
            {
                col.Item().Text("STOCK SUMMARY").FontSize(8).Bold().FontColor(MutedLabel);
                col.Item().PaddingTop(4).Table(table =>
                {
                    table.ColumnsDefinition(c => { c.RelativeColumn(2); c.RelativeColumn(1.5f); c.RelativeColumn(1.5f); c.RelativeColumn(1.5f); c.RelativeColumn(1.5f); });
                    HeaderRow(table, "Material", "Starting Stock", "Deliveries", "Consumption", "Ending Stock");
                    foreach (var s in data.MaterialSummaries)
                    {
                        table.Cell().BorderBottom(0.5f).BorderColor(DividerColor).Padding(4).Text(s.Material).FontSize(8.5f);
                        table.Cell().BorderBottom(0.5f).BorderColor(DividerColor).Padding(4).AlignRight().Text(FmtQty(s.StartingStock)).FontSize(8.5f);
                        table.Cell().BorderBottom(0.5f).BorderColor(DividerColor).Padding(4).AlignRight().Text(FmtQty(s.Deliveries)).FontSize(8.5f);
                        table.Cell().BorderBottom(0.5f).BorderColor(DividerColor).Padding(4).AlignRight().Text(FmtQty(s.Consumption)).FontSize(8.5f);
                        table.Cell().BorderBottom(0.5f).BorderColor(DividerColor).Padding(4).AlignRight().Text(FmtQty(s.EndingStock)).FontSize(8.5f);
                    }
                });
                col.Item().PaddingTop(14);
            }

            // Grouped into one section per material — caller already sorts
            // lines by Material then ExpiryDate, matching Node's own
            // consecutive-run grouping (not a full GROUP BY re-sort).
            foreach (var group in GroupConsecutiveByMaterial(data.Lines))
            {
                col.Item().Element(c => DrawMaterialGroup(c, group.Material, group.Lines));
                col.Item().PaddingTop(6);
            }

            col.Item().PaddingTop(6).AlignRight().Text($"Total Declared: {FmtQty(data.TotalQty)}").FontSize(10).Bold();
        });
    }

    private static List<(string Material, List<ConsignmentDeclarationLineRow> Lines)> GroupConsecutiveByMaterial(IReadOnlyList<ConsignmentDeclarationLineRow> lines)
    {
        var groups = new List<(string Material, List<ConsignmentDeclarationLineRow> Lines)>();
        foreach (var line in lines)
        {
            var material = line.Material ?? "";
            if (groups.Count > 0 && groups[^1].Material == material)
                groups[^1].Lines.Add(line);
            else
                groups.Add((material, [line]));
        }
        return groups;
    }

    private static void DrawMaterialGroup(IContainer container, string material, List<ConsignmentDeclarationLineRow> lines)
    {
        container.Column(col =>
        {
            col.Item().Background(Teal).Padding(6).Text(string.IsNullOrEmpty(material) ? "(no material)" : material).FontSize(9).Bold().FontColor(Colors.White);

            col.Item().Table(table =>
            {
                table.ColumnsDefinition(c => { c.RelativeColumn(2.5f); c.RelativeColumn(1.8f); c.RelativeColumn(1.5f); c.RelativeColumn(1.8f); });
                HeaderRow(table, "Invoice / Ref", "GR Doc", "Expiry", "Qty Declared");

                decimal subtotal = 0;
                var uom = "";
                foreach (var line in lines)
                {
                    table.Cell().BorderBottom(0.5f).BorderColor(DividerColor).Padding(4).Text(line.InvoiceNumber.NullIfEmpty() ?? "—").FontSize(8.5f);
                    table.Cell().BorderBottom(0.5f).BorderColor(DividerColor).Padding(4).Text(line.MaterialDocument.NullIfEmpty() ?? "—").FontSize(8.5f);
                    table.Cell().BorderBottom(0.5f).BorderColor(DividerColor).Padding(4).Text(line.ExpiryDate is not null ? FmtDate(line.ExpiryDate.Value) : "—").FontSize(8.5f);
                    table.Cell().BorderBottom(0.5f).BorderColor(DividerColor).Padding(4).AlignRight()
                        .Text($"{FmtQty(line.QtyAllocated)}{(string.IsNullOrEmpty(line.Uom) ? "" : " " + line.Uom)}").FontSize(8.5f);
                    subtotal += line.QtyAllocated;
                    uom = uom.Length > 0 ? uom : (line.Uom ?? "");
                }

                table.Cell().ColumnSpan(4).Background(SubtotalPanel).Padding(6).AlignRight()
                    .Text($"Subtotal — {(string.IsNullOrEmpty(material) ? "(no material)" : material)}: {FmtQty(subtotal)}{(uom.Length > 0 ? " " + uom : "")}").FontSize(8.5f).Bold();
            });
        });
    }

    private static void HeaderRow(TableDescriptor table, params string[] labels)
    {
        foreach (var label in labels)
            table.Cell().Background(PanelGrey).Padding(4).Text(label.ToUpperInvariant()).FontSize(7.5f).Bold().FontColor("#374151");
    }

    private static void DrawFooter(IContainer container)
    {
        container.BorderTop(1).BorderColor(Teal).PaddingTop(4)
            .Text($"Generated {FmtDate(DateTime.Now)} — {KongsbergName}").FontSize(7).FontColor("#9ca3af");
    }

    private static string FmtDate(DateTime d) => d.ToString("dd MMM yyyy", System.Globalization.CultureInfo.GetCultureInfo("en-GB"));

    private static string FmtQty(decimal value) => value.ToString("#,##0.###", System.Globalization.CultureInfo.GetCultureInfo("en-GB"));
}

file static class StringExtensions
{
    internal static string? NullIfEmpty(this string? value) => string.IsNullOrWhiteSpace(value) ? null : value;
}
