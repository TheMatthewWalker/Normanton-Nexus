using NormantonNexus.Models.Dto;
using QuestPDF.Fluent;
using QuestPDF.Helpers;
using QuestPDF.Infrastructure;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Packing list + loading list PDF generation — Logistics Sub-phase 8a.3.
/// Port of routes/shipmentmain.js's createShipmentPackingListPdfBuffer/
/// createLoadingListPdfBuffer.
///
/// DEVIATION, deliberate, same precedent as Production's LabelPdfHelper.cs:
/// Node's hand-rolled versions manually emit raw PDF content-stream
/// operators (BT/Tf/Tm/Tj/re/m/l/S — a whole miniature PDF-object-model
/// builder, buildPdfFromPages, that exists purely because this repo has no
/// PDF library dependency in that file) at fixed x/y coordinates. This
/// port uses QuestPDF's declarative Row/Column/Table layout instead of
/// reproducing that coordinate math — same content, same visual grouping
/// (header band, address/details cards, summary cards, a data table,
/// footer), QuestPDF-idiomatic structure. Not pixel-verified against
/// Node's output (no PDF viewer in this sandbox) — see
/// LabelPdfHelperTests's own precedent for why structural tests (valid
/// PDF, correct page behavior) are what's actually checkable here.
/// </summary>
internal static class ShipmentPackingListPdfHelper
{
    static ShipmentPackingListPdfHelper()
    {
        QuestPDF.Settings.License = QuestPDF.Infrastructure.LicenseType.Community;
    }

    private const string Navy = "#0f2742";
    private const string Steel = "#5b7088";
    private const string Light = "#e8eef5";
    private const string Soft = "#f7f9fc";
    private const string Ink = "#1c2733";
    private const string LineColor = "#c7d3df";

    internal static byte[] BuildPackingListPdf(ShipmentContext context)
    {
        var shipment = context.Shipment;
        var isManual = shipment.IsManual;
        var ref_ = ShipmentHelper.FormatShipmentRef(shipment.ShipmentId);
        var plannedDate = shipment.PlannedDelivery ?? shipment.PlannedCollection;
        var linkedRefs = context.Deliveries.Count > 0 ? string.Join(", ", context.Deliveries.Select(d => d.DeliveryId)) : "-";
        var addressLines = new[] { shipment.DestinationName, shipment.DestinationStreet, JoinNonEmpty(" ", shipment.DestinationPostCode, shipment.DestinationCity), shipment.DestinationCountry }
            .Where(l => !string.IsNullOrWhiteSpace(l)).ToList();

        var document = Document.Create(container =>
        {
            container.Page(page =>
            {
                page.Size(PageSizes.A4);
                page.Margin(36, Unit.Point);
                page.DefaultTextStyle(t => t.FontColor(Ink));

                page.Header().Element(c => DrawHeader(c, shipment, ref_, plannedDate, addressLines, linkedRefs, isManual));
                page.Content().PaddingTop(10).Element(c => DrawTable(c, context, isManual));
                page.Footer().Element(DrawDriverConfirmationFooter);
            });
        });

        return document.GeneratePdf();
    }

    private static void DrawHeader(IContainer container, ShipmentRow shipment, string ref_, DateTime? plannedDate, List<string?> addressLines, string linkedRefs, bool isManual)
    {
        container.Column(col =>
        {
            col.Item().Background(Navy).Padding(12).Row(row =>
            {
                row.RelativeItem().Column(h =>
                {
                    h.Item().Text("Kongsberg Automotive").FontSize(18).Bold().FontColor(Colors.White);
                    h.Item().Text("Shipment Packing List").FontSize(10).FontColor(Colors.White);
                });
                row.ConstantItem(150).AlignRight().AlignMiddle().Text($"Ref {ref_}").FontSize(13).Bold().FontColor(Colors.White);
            });

            col.Item().PaddingTop(8).Row(row =>
            {
                row.Spacing(8);
                row.RelativeItem().Background(Soft).Padding(10).Column(c =>
                {
                    c.Item().Text("Delivery Address").FontSize(10).Bold().FontColor(Navy);
                    foreach (var line in addressLines) c.Item().Text(line!).FontSize(9);
                });
                row.RelativeItem().Background(Soft).Padding(10).Column(c =>
                {
                    c.Item().Text("Shipment Details").FontSize(10).Bold().FontColor(Navy);
                    c.Item().Text($"Forwarder: {shipment.ForwarderName.NullIfEmpty() ?? shipment.ForwarderId?.ToString() ?? "-"}").FontSize(9);
                    c.Item().Text($"Planned Date: {(plannedDate is not null ? plannedDate.Value.ToString("dd/MM/yyyy") : "-")}").FontSize(9);
                    c.Item().Text($"Tracking: {shipment.TrackingNumber.NullIfEmpty() ?? "-"}").FontSize(9);
                });
            });

            col.Item().PaddingTop(8).Background(Light).Padding(8)
                .Text(isManual ? "Manual Shipment - not linked to SAP deliveries" : $"Linked Deliveries: {linkedRefs}").FontSize(9).Bold().FontColor(Navy);

            col.Item().PaddingTop(8).Row(row =>
            {
                row.Spacing(6);
                DrawSummaryCard(row, isManual ? "Package Count" : "Pallet Count", $"{shipment.PalletCount ?? 0:0.###}");
                DrawSummaryCard(row, "Gross Weight", $"{shipment.GrossWeight ?? 0:0.###} KG");
                DrawSummaryCard(row, "Net Weight", $"{shipment.NetWeight ?? 0:0.###} KG");
                DrawSummaryCard(row, "Volume", $"{shipment.ShipmentVolume ?? 0:0.###} CBM");
            });
        });
    }

    private static void DrawSummaryCard(RowDescriptor row, string label, string value)
    {
        row.RelativeItem().Background(Soft).Padding(8).Column(c =>
        {
            c.Item().Text(label).FontSize(8).Bold().FontColor(Steel);
            c.Item().Text(value).FontSize(10).Bold().FontColor(Navy);
        });
    }

    private static void DrawTable(IContainer container, ShipmentContext context, bool isManual)
    {
        if (isManual)
        {
            var rows = context.ManualCargo;
            container.Table(table =>
            {
                table.ColumnsDefinition(c => { c.RelativeColumn(1); c.RelativeColumn(3); c.RelativeColumn(1); c.RelativeColumn(2); c.RelativeColumn(1.5f); c.RelativeColumn(1.5f); });
                HeaderRow(table, "Ref", "Description", "Qty", "Dimensions", "Weight", "Volume");
                if (rows.Count == 0)
                {
                    table.Cell().ColumnSpan(6).Padding(6).Text("No cargo lines recorded for this manual shipment.").FontSize(9);
                }
                else
                {
                    foreach (var (item, i) in rows.Select((r, i) => (r, i)))
                    {
                        var dims = (item.Length ?? item.Width ?? item.Height) is not null ? $"{item.Length ?? 0} x {item.Width ?? 0} x {item.Height ?? 0}" : "-";
                        DataRow(table, i,
                            item.CargoId.ToString(), Truncate(item.Description ?? "Cargo", 40), (item.PackageCount == 0 ? 1 : item.PackageCount).ToString(),
                            dims, $"{item.Weight:0.###} KG", $"{item.Volume ?? 0:0.###} CBM");
                    }
                }
            });
        }
        else
        {
            var rows = context.Pallets;
            container.Table(table =>
            {
                table.ColumnsDefinition(c => { c.RelativeColumn(1); c.RelativeColumn(1); c.RelativeColumn(1.3f); c.RelativeColumn(1.6f); c.RelativeColumn(1); c.RelativeColumn(1); c.RelativeColumn(1); c.RelativeColumn(1.6f); });
                HeaderRow(table, "Delivery", "Pallet", "Type", "Dimensions", "Gross", "Net", "Volume", "Location");
                if (rows.Count == 0)
                {
                    table.Cell().ColumnSpan(8).Padding(6).Text("No pallets linked to this shipment.").FontSize(9);
                }
                else
                {
                    foreach (var (pallet, i) in rows.Select((r, i) => (r, i)))
                    {
                        var netWeight = pallet.GrossWeight - pallet.PackagingWeight;
                        DataRow(table, i,
                            pallet.DeliveryId.ToString(), pallet.PalletId.ToString(), pallet.PalletType ?? "",
                            $"{pallet.PalletLength ?? 0} x {pallet.PalletWidth ?? 0} x {pallet.PalletHeight ?? 0}",
                            $"{pallet.GrossWeight:0.###} KG", $"{netWeight:0.###} KG", $"{pallet.PalletVolume:0.###} CBM", pallet.PalletLocation ?? "");
                    }
                }
            });
        }
    }

    private static void HeaderRow(TableDescriptor table, params string[] labels)
    {
        foreach (var label in labels)
            table.Cell().Background(Navy).Padding(6).Text(label).FontSize(8.5f).Bold().FontColor(Colors.White);
    }

    private static void DataRow(TableDescriptor table, int index, params string[] values)
    {
        var bg = index % 2 == 0 ? Soft : "#FFFFFF";
        foreach (var value in values)
            table.Cell().Background(bg).BorderBottom(0.8f).BorderColor(LineColor).Padding(6).Text(value).FontSize(8.5f);
    }

    private static void DrawDriverConfirmationFooter(IContainer container)
    {
        container.BorderTop(1).BorderColor(LineColor).PaddingTop(8).Column(col =>
        {
            col.Item().Text("Driver Collection Confirmation").FontSize(10).Bold().FontColor(Navy);
            col.Item().PaddingTop(6).Row(row =>
            {
                row.RelativeItem(3).Text("Haulage company name: ____________________________").FontSize(9);
                row.RelativeItem(1).Text("Reg: __________").FontSize(9);
                row.RelativeItem(2).Text("Trailer No: __________").FontSize(9);
            });
            col.Item().PaddingTop(10).Row(row =>
            {
                row.RelativeItem(3).Text("Driver name: ____________________________").FontSize(9);
                row.RelativeItem(3).Text("Date: __________").FontSize(9);
            });
        });
    }

    // ── Loading list (multi-shipment) ────────────────────────────────

    internal static byte[] BuildLoadingListPdf(IReadOnlyList<(ShipmentRow Shipment, IReadOnlyList<ShipmentContextPalletRow> Pallets)> shipmentsData)
    {
        var now = DateTime.Now;

        var document = Document.Create(container =>
        {
            container.Page(page =>
            {
                page.Size(PageSizes.A4);
                page.Margin(36, Unit.Point);
                page.DefaultTextStyle(t => t.FontColor(Ink));

                page.Header().Background(Navy).Padding(10).Row(row =>
                {
                    row.RelativeItem().Column(h =>
                    {
                        h.Item().Text("Kongsberg Automotive — Loading List").FontSize(13).Bold().FontColor(Colors.White);
                        h.Item().Text($"Generated: {now:dd/MM/yyyy HH:mm}").FontSize(8.5f).FontColor(Colors.White);
                    });
                    row.ConstantItem(80).AlignRight().AlignMiddle().Text(text =>
                    {
                        text.CurrentPageNumber().FontSize(8.5f).FontColor(Colors.White);
                        text.Span(" / ").FontSize(8.5f).FontColor(Colors.White);
                        text.TotalPages().FontSize(8.5f).FontColor(Colors.White);
                    });
                });

                page.Content().PaddingTop(10).Column(col =>
                {
                    col.Spacing(14);
                    foreach (var (shipment, pallets) in shipmentsData)
                        col.Item().Element(c => DrawLoadingListShipment(c, shipment, pallets));
                });
            });
        });

        return document.GeneratePdf();
    }

    private static void DrawLoadingListShipment(IContainer container, ShipmentRow shipment, IReadOnlyList<ShipmentContextPalletRow> pallets)
    {
        container.Column(col =>
        {
            var ref_ = ShipmentHelper.FormatShipmentRef(shipment.ShipmentId);
            var planned = shipment.PlannedCollection is not null ? shipment.PlannedCollection.Value.ToString("dd/MM/yyyy") : "—";

            col.Item().Background(Light).BorderTop(1).BorderColor(Navy).Padding(6).Row(row =>
            {
                row.RelativeItem(2).Text($"Shipment {ref_}").FontSize(9).Bold().FontColor(Navy);
                row.RelativeItem(3).Text($"Dest: {Truncate(shipment.DestinationName ?? "—", 28)}").FontSize(8).FontColor(Steel);
                row.RelativeItem(3).Text($"Haulier: {Truncate(shipment.ForwarderName ?? "—", 18)}").FontSize(8).FontColor(Steel);
                row.RelativeItem(2).Text($"Planned: {planned}").FontSize(8).FontColor(Steel);
            });

            col.Item().Table(table =>
            {
                table.ColumnsDefinition(c => { c.RelativeColumn(1); c.RelativeColumn(1); c.RelativeColumn(1.3f); c.RelativeColumn(1); c.RelativeColumn(1.8f); });
                table.Cell().Background(Navy).Padding(4).Text("Pallet ID").FontSize(7.5f).Bold().FontColor(Colors.White);
                table.Cell().Background(Navy).Padding(4).Text("Type").FontSize(7.5f).Bold().FontColor(Colors.White);
                table.Cell().Background(Navy).Padding(4).Text("Location").FontSize(7.5f).Bold().FontColor(Colors.White);
                table.Cell().Background(Navy).Padding(4).Text("Gross Wt").FontSize(7.5f).Bold().FontColor(Colors.White);
                table.Cell().Background(Navy).Padding(4).Text("Dimensions (L×W×H mm)").FontSize(7.5f).Bold().FontColor(Colors.White);

                if (pallets.Count == 0)
                {
                    table.Cell().ColumnSpan(5).Padding(6).Text("No pallets linked to this shipment.").FontSize(8.5f).FontColor(Steel);
                }
                else
                {
                    foreach (var (pallet, i) in pallets.Select((p, i) => (p, i)))
                    {
                        var bg = i % 2 == 0 ? Soft : "#FFFFFF";
                        table.Cell().Background(bg).BorderBottom(0.5f).BorderColor(LineColor).Padding(4).Text(pallet.PalletId.ToString()).FontSize(8);
                        table.Cell().Background(bg).BorderBottom(0.5f).BorderColor(LineColor).Padding(4).Text(pallet.PalletType ?? "").FontSize(8);
                        table.Cell().Background(bg).BorderBottom(0.5f).BorderColor(LineColor).Padding(4).Text(pallet.PalletLocation ?? "—").FontSize(8);
                        table.Cell().Background(bg).BorderBottom(0.5f).BorderColor(LineColor).Padding(4).Text($"{pallet.GrossWeight:0.###} kg").FontSize(8);
                        table.Cell().Background(bg).BorderBottom(0.5f).BorderColor(LineColor).Padding(4).Text($"{pallet.PalletLength ?? 0} × {pallet.PalletWidth ?? 0} × {pallet.PalletHeight ?? 0}").FontSize(8);
                    }
                }
            });
        });
    }

    private static string Truncate(string value, int max) => value.Length > max ? value[..max] : value;

    private static string? JoinNonEmpty(string separator, params string?[] values) =>
        string.Join(separator, values.Where(v => !string.IsNullOrWhiteSpace(v)));
}

file static class StringExtensions
{
    internal static string? NullIfEmpty(this string? value) => string.IsNullOrWhiteSpace(value) ? null : value;
}
