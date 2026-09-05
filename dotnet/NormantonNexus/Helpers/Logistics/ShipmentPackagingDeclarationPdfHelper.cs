using NormantonNexus.Models.Dto;
using QuestPDF.Fluent;
using QuestPDF.Helpers;
using QuestPDF.Infrastructure;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Packaging Declaration of Conformity PDF — Logistics Sub-phase 8a.3.
/// Port of lib/packagingDeclarationPdf.js's buildPackagingDeclarationPdf
/// (Regulation (EU) 2025/40 on packaging and packaging waste). One-page,
/// shipment-accompanying customs/compliance declaration reproducing the
/// layout of the reference "Kongsberg_One_Page_Packaging_Declaration_
/// Customs.docx" — same content, sections and fixed legal text as Node's
/// pdfkit version, rebuilt with QuestPDF's declarative layout instead of
/// pdfkit's manual x/y cursor positioning (same "deliberate non-pixel-
/// perfect, QuestPDF-idiomatic re-layout" precedent as LabelPdfHelper.cs
/// and ShipmentPackingListPdfHelper.cs). Node's own comment notes the
/// reference docx is explicitly single-page with no variable-length line
/// items — this port relies on QuestPDF's own automatic pagination as the
/// safety net for an unusually long value, rather than porting Node's
/// manual ensureSpace()/buffered-page-footer-loop machinery.
/// </summary>
internal static class ShipmentPackagingDeclarationPdfHelper
{
    static ShipmentPackagingDeclarationPdfHelper()
    {
        QuestPDF.Settings.License = QuestPDF.Infrastructure.LicenseType.Community;
    }

    private const string Teal = "#0d4c45";
    private const string DarkBlue = "#003B5C";
    private const string Ink = "#111827";
    private const string MutedLabel = "#6b7280";
    private const string PanelGrey = "#f5f7f8";
    private const string PanelBlue = "#EAF4F8";
    private const string DividerColor = "#e5e7eb";

    private const string KongsbergName = "Kongsberg Actuation System Ltd";
    private const string KongsbergIssuer = "Kongsberg Actuation Systems Ltd t/a Kongsberg Automotive";
    private const string KongsbergAddress = "Unit C, Euroflex Centre, Foxbridge Way, Normanton, West Yorkshire, WF6 1TN, UK";
    private const string KongsbergRegistration = "England No. 06444481";
    private const string KongsbergContact = "+44 1924 228 000";

    private const string DeclarationText =
        "We declare under our sole responsibility that the packaging identified above and supplied with this delivery is " +
        "intended for the containment, protection, handling and transport of industrial goods and complies with the " +
        "applicable requirements of Regulation (EU) 2025/40 on packaging and packaging waste, on the basis of the " +
        "relevant packaging specifications and supporting supplier documentation retained by the company.";

    private const string RestrictedSubstancesText =
        "The presence and concentration of substances of concern are minimised. The sum of lead, cadmium, mercury and " +
        "hexavalent chromium in the packaging or its components does not exceed 100 mg/kg, except where a lawful " +
        "exemption applies. The packaging is not intended for food contact. Any material, coating, ink, adhesive, " +
        "treatment or supplier change is subject to reassessment.";

    private const string LegalFooterText =
        "Legal reference: Regulation (EU) 2025/40 of 19 December 2024 on packaging and packaging waste, OJ L 2025/40, " +
        "22 January 2025. This declaration accompanies the shipment and does not replace the supporting technical documentation.";

    private static readonly (string Key, string Label, string Caption)[] PackagingItems =
    [
        ("WoodenPallets", "Wooden pallets", "Solid wood"),
        ("WoodenSpools", "Wooden spools", "Solid wood"),
        ("CardboardBoxes", "Cardboard boxes", "Corrugated fibreboard"),
        ("BubblewrapSheets", "Bubblewrap sheets", "Flexible plastic cushioning"),
    ];

    internal sealed record Input(
        string ShipmentRef, string? DeliveryRef, string? CustomerName, DateTime? DispatchDate,
        PackagingDeclarationOptions Packaging, string Ispm15, bool DunnageConfirmed, string ContainerClean,
        string SignedByName, string SignedByPosition, DateTime SignedAt);

    internal static byte[] Build(Input data)
    {
        var document = Document.Create(container =>
        {
            container.Page(page =>
            {
                page.Size(PageSizes.A4);
                page.Margin(28, Unit.Point);
                page.DefaultTextStyle(t => t.FontColor(Ink));

                page.Header().Element(c => DrawHeaderBand(c, data.ShipmentRef));
                page.Content().PaddingTop(14).Element(c => DrawBody(c, data));
                page.Footer().Element(DrawFooter);
            });
        });

        return document.GeneratePdf();
    }

    private static void DrawHeaderBand(IContainer container, string shipmentRef)
    {
        container.Background(Teal).Padding(12).Row(row =>
        {
            row.RelativeItem().Text("KONGSBERG AUTOMOTIVE").FontSize(15).Bold().FontColor(Colors.White);
            row.RelativeItem().AlignRight().Text("PACKAGING DECLARATION OF CONFORMITY").FontSize(13).Bold().FontColor(Colors.White);
        });
    }

    private static void DrawBody(IContainer container, Input data)
    {
        container.Column(col =>
        {
            col.Item().Text("Shipment-accompanying declaration for EU customs and customer clearance").FontSize(8).FontColor(MutedLabel);

            col.Item().PaddingTop(10).Row(row =>
            {
                row.Spacing(20);
                row.RelativeItem().Column(c =>
                {
                    LabelValue(c, "Issuer", KongsbergIssuer);
                    LabelValue(c, "Address", KongsbergAddress);
                    LabelValue(c, "Registration", KongsbergRegistration);
                    LabelValue(c, "Contact", KongsbergContact);
                });
                row.RelativeItem().Column(c =>
                {
                    LabelValue(c, "Delivery / invoice no.", data.DeliveryRef ?? "—");
                    LabelValue(c, "Consignment / shipment no.", data.ShipmentRef);
                    LabelValue(c, "Customer / consignee", data.CustomerName ?? "—");
                    LabelValue(c, "Date of dispatch", FmtDate(data.DispatchDate));
                });
            });

            col.Item().PaddingTop(10).BorderBottom(1).BorderColor(Teal).PaddingBottom(2);

            col.Item().PaddingTop(12).Text("PACKAGING INCLUDED IN THIS DELIVERY").FontSize(10.5f).Bold().FontColor(Teal);
            col.Item().PaddingTop(6).Background(DarkBlue).Padding(6).Row(row =>
            {
                row.Spacing(4);
                foreach (var item in PackagingItems)
                {
                    var checkedItem = item.Key switch
                    {
                        "WoodenPallets" => data.Packaging.WoodenPallets,
                        "WoodenSpools" => data.Packaging.WoodenSpools,
                        "CardboardBoxes" => data.Packaging.CardboardBoxes,
                        _ => data.Packaging.BubblewrapSheets,
                    };
                    row.RelativeItem().Row(r =>
                    {
                        r.AutoItem().Element(e => DrawCheckbox(e, checkedItem));
                        r.RelativeItem().PaddingLeft(4).AlignMiddle().Text(item.Label).FontSize(9).Bold().FontColor(Colors.White);
                    });
                }
            });
            col.Item().Background(PanelGrey).Padding(4).Row(row =>
            {
                foreach (var item in PackagingItems)
                    row.RelativeItem().AlignCenter().Text(item.Caption).FontSize(7.5f).FontColor(MutedLabel);
            });

            col.Item().PaddingTop(12).Text("DECLARATION").FontSize(10.5f).Bold().FontColor(Teal);
            col.Item().PaddingTop(4).Background(PanelBlue).Padding(8).Text(DeclarationText).FontSize(9);

            col.Item().PaddingTop(10).Background(PanelGrey).Padding(8).Text(text =>
            {
                text.Span("RESTRICTED SUBSTANCES: ").FontSize(9).Bold().FontColor(DarkBlue);
                text.Span(RestrictedSubstancesText).FontSize(9);
            });

            col.Item().PaddingTop(12).Text("WOOD PACKAGING AND SHIPMENT STATEMENTS").FontSize(10.5f).Bold().FontColor(Teal);
            col.Item().PaddingTop(4).Element(c => DrawWoodStatement(c, 0, "Where wooden pallets or wooden spools are used, applicable ISPM 15 treatment and marking requirements have been met.",
                r => DrawYesNa(r, data.Ispm15 == "yes")));
            col.Item().Element(c => DrawWoodStatement(c, 1, "No straw, hay, peat, chaff or used fruit/vegetable cartons have been used as packaging or dunnage.",
                r => DrawCheckboxLabel(r, data.DunnageConfirmed, "Confirmed")));
            col.Item().Element(c => DrawWoodStatement(c, 2, "For containerised shipments, the container is clean and free from visible animal/plant material and soil.",
                r => DrawYesNa(r, data.ContainerClean == "yes")));

            col.Item().PaddingTop(12).Text("AUTHORISED SIGNATURE FOR THIS DELIVERY").FontSize(10.5f).Bold().FontColor(Teal);
            col.Item().PaddingTop(6).Row(row =>
            {
                row.Spacing(20);
                row.RelativeItem().Column(c =>
                {
                    LabelValue(c, "Name", data.SignedByName);
                    LabelValue(c, "Signature", $"Electronically signed by {data.SignedByName}", italic: true);
                });
                row.RelativeItem().Column(c =>
                {
                    LabelValue(c, "Position", data.SignedByPosition);
                    LabelValue(c, "Issue date", FmtDateTime(data.SignedAt));
                });
            });

            col.Item().PaddingTop(14).Text(LegalFooterText).FontSize(7).FontColor(MutedLabel);
        });
    }

    private static void LabelValue(ColumnDescriptor col, string label, string value, bool italic = false)
    {
        col.Item().PaddingBottom(6).Column(c =>
        {
            c.Item().Text(label.ToUpperInvariant()).FontSize(8).Bold().FontColor(MutedLabel);
            var text = c.Item().Text(value).FontSize(9.5f);
            if (italic) text.Italic();
        });
    }

    private static void DrawWoodStatement(IContainer container, int index, string text, Action<RowDescriptor> drawValue)
    {
        container.Background(index % 2 == 0 ? PanelGrey : "#FFFFFF").BorderBottom(0.5f).BorderColor(DividerColor).Padding(6).Row(row =>
        {
            row.RelativeItem(3).AlignMiddle().Text(text).FontSize(8.5f);
            row.RelativeItem(1).AlignMiddle().Row(drawValue);
        });
    }

    private static void DrawYesNa(RowDescriptor row, bool isYes)
    {
        row.AutoItem().Element(e => DrawCheckboxLabelElement(e, isYes, "Yes"));
        row.ConstantItem(10);
        row.AutoItem().Element(e => DrawCheckboxLabelElement(e, !isYes, "N/A"));
    }

    private static void DrawCheckboxLabel(RowDescriptor row, bool isChecked, string label) =>
        row.AutoItem().Element(e => DrawCheckboxLabelElement(e, isChecked, label));

    private static void DrawCheckboxLabelElement(IContainer container, bool isChecked, string label)
    {
        container.Row(r =>
        {
            r.AutoItem().Element(e => DrawCheckbox(e, isChecked));
            r.AutoItem().PaddingLeft(3).AlignMiddle().Text(label).FontSize(9).Bold().FontColor(DarkBlue);
        });
    }

    private static void DrawCheckbox(IContainer container, bool isChecked)
    {
        container.Width(11).Height(11).Border(1).BorderColor(Teal).Background(isChecked ? Teal : Colors.White);
    }

    private static void DrawFooter(IContainer container)
    {
        container.BorderTop(1).BorderColor(Teal).PaddingTop(4)
            .Text($"Generated {FmtDateTime(DateTime.Now)} — {KongsbergName}").FontSize(7).FontColor("#9ca3af");
    }

    private static string FmtDate(DateTime? d) => d is null ? "—" : d.Value.ToString("dd MMM yyyy", System.Globalization.CultureInfo.GetCultureInfo("en-GB"));

    private static string FmtDateTime(DateTime d) => $"{FmtDate(d)} {d:HH:mm}";
}
