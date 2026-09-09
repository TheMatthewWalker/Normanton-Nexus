using System.Globalization;
using QuestPDF.Fluent;
using QuestPDF.Helpers;
using QuestPDF.Infrastructure;

namespace NormantonNexus.Helpers.Logistics;

internal sealed record PoPdfItem(string PoItemNumber, string? Material, string? MaterialText, decimal Quantity, string Uom, DateTime? DeliveryDate, bool IsExw, decimal? NetPrice);

internal sealed record PoPdfData(string PoNumber, DateTime? PoDate, string? VendorName, string? SapVendorNumber, string? Currency, string? Incoterms, string? PurchaserName, IReadOnlyList<PoPdfItem> Items);

/// <summary>
/// Purchase Order PDF generation — Logistics Sub-phase 8b.7. Port of
/// lib/poPdf.js's buildPoPdf, generated straight after a real SAP PO is
/// raised (POST /order-suggestions/create-po) or re-rendered later for one
/// that already exists (POST /order-suggestions/regenerate-pdf).
///
/// DEVIATION, deliberate, same precedent as ShipmentPackingListPdfHelper/
/// Production's LabelPdfHelper: Node's version hand-positions everything at
/// fixed x/y coordinates via pdfkit; this uses QuestPDF's declarative
/// Row/Column/Table layout instead, so the manual page-break math Node
/// needs (checking `y` against the page height before every block) isn't
/// needed here at all — QuestPDF reflows pagination on its own. Same
/// content, same section order (header, supplier/ordered-by/date meta,
/// line-items table, T&amp;Cs, supplier notice + sign-off, footer). Not
/// pixel-verified against Node's output (no PDF viewer in this sandbox) —
/// see LabelPdfHelperTests' own precedent for why structural tests (valid
/// PDF, correct content) are what's actually checkable here. The Kongsberg
/// logo Node conditionally draws (best-effort, silently skipped if missing)
/// is omitted entirely — purely cosmetic and the logo asset was never
/// copied into this project's wwwroot, so there's nothing to embed yet.
///
/// The Terms &amp; Conditions and supplier-certification notice text below
/// are transcribed VERBATIM from lib/poPdf.js's own TERMS_AND_CONDITIONS/
/// SUPPLIER_NOTICE constants — both are binding legal/compliance wording
/// copied from a real SAP-issued PO, not paraphrased, and must never be
/// reworded independently of that source.
/// </summary>
internal static class PurchaseOrderPdfHelper
{
    static PurchaseOrderPdfHelper()
    {
        QuestPDF.Settings.License = LicenseType.Community;
    }

    private const string BrandBlue = "#2563EB";
    private const string Ink = "#111827";
    private const string InkDim = "#6b7280";
    private const string Rule = "#e5e7eb";
    private const string HeaderFill = "#f3f4f6";

    // Kongsberg's own origin address — hardcoded the same way
    // ShipmentHelper's own logistics settings hardcode it elsewhere in this
    // migration (no per-environment config for this — it's the one
    // physical site this app runs at).
    private const string KongsbergName = "Kongsberg Actuation System Ltd";
    private const string KongsbergStreet = "Euroflex Centre, Foxbridge Way";
    private const string KongsbergCity = "Normanton";
    private const string KongsbergPostcode = "WF6 1TN";
    private const string KongsbergCountry = "United Kingdom";
    private const string KongsbergVat = "GB214987833";

    /// <summary>Standard Kongsberg Automotive purchasing terms &amp; conditions — copied verbatim from a real SAP-issued PO, binding wording.</summary>
    private const string TermsAndConditions =
        "This Purchase Order is subject to Kongsberg Automotive General Purchasing Conditions and any amendments, " +
        "addenda or modifications thereto (collectively the \"Purchase Terms\"), the Supplier Quality Manual and " +
        "Supplier Declaration, as in effect on the date of this Purchase Order. The Purchase Terms, Supplier Quality " +
        "Manual and Supplier Declaration are available at www.kongsbergautomotive.com/for_suppliers/";

    /// <summary>Standard supplier certification/labelling notice, printed under the T&amp;Cs on every PO — verbatim, binding wording.</summary>
    private const string SupplierNotice =
        "Please note that your company is required to be certified against the latest version of ISO 9001, " +
        "with the target of achieving IATF 16949, as well as ISO 14001 or EMAS.\n\n" +
        "Supplier, order and part numbers, must always be stated on order acknowledgements, invoices, packing " +
        "notes and goods labels.";

    private static readonly CultureInfo EnGb = CultureInfo.GetCultureInfo("en-GB");

    private static string FmtDate(DateTime? d) => d?.ToString("dd MMM yyyy", EnGb) ?? "—";

    private static string FmtQty(decimal n) => n.ToString("#,##0.###", EnGb);

    private static string? FmtPrice(decimal? n, string? currency) => n is null ? null : $"{currency} {n.Value.ToString("0.00", EnGb)}".Trim();

    internal static byte[] BuildPoPdf(PoPdfData data)
    {
        var allExw = data.Items.Count > 0 && data.Items.All(i => i.IsExw);
        var deliveryLabel = allExw ? "Ex Works Date" : "Delivery Date";
        var hasPrice = data.Items.Any(i => i.NetPrice is not null);
        var allPriced = data.Items.Count > 0 && data.Items.All(i => i.NetPrice is not null);
        var priceTotal = data.Items.Where(i => i.NetPrice is not null).Sum(i => i.Quantity * i.NetPrice!.Value);

        var document = Document.Create(container =>
        {
            container.Page(page =>
            {
                page.Size(PageSizes.A4);
                page.Margin(40, Unit.Point);
                page.DefaultTextStyle(t => t.FontColor(Ink));

                page.Header().Element(c => DrawHeader(c, data));
                page.Content().PaddingTop(16).Column(col =>
                {
                    col.Item().Element(c => DrawItemsTable(c, data.Items, deliveryLabel, hasPrice, data.Currency));

                    if (hasPrice && allPriced)
                        col.Item().PaddingTop(4).AlignRight().Text($"Total: {FmtPrice(priceTotal, data.Currency)}").FontSize(9).Bold().FontColor(Ink);

                    if (!hasPrice)
                        col.Item().PaddingTop(10).Text("Pricing determined by SAP purchasing info record / condition records at time of order — not shown on this document.")
                            .FontSize(8).Italic().FontColor(InkDim);

                    col.Item().PaddingTop(16).Element(DrawTermsAndConditions);
                    col.Item().PaddingTop(16).Element(c => DrawSupplierNoticeAndSignOff(c, data.PurchaserName));
                });
                page.Footer().Element(DrawFooter);
            });
        });

        return document.GeneratePdf();
    }

    private static void DrawHeader(IContainer container, PoPdfData data)
    {
        container.Column(col =>
        {
            col.Item().Text(t =>
            {
                t.Span("Purchase Order").FontSize(22).Bold().FontColor(Ink);
                t.Span($" {data.PoNumber}").FontSize(22).FontColor(BrandBlue);
            });
            col.Item().PaddingTop(8).BorderBottom(2).BorderColor(BrandBlue);

            col.Item().PaddingTop(12).Row(row =>
            {
                row.RelativeItem(2).Column(c =>
                {
                    c.Item().Text("SUPPLIER").FontSize(8).Bold().FontColor(InkDim);
                    c.Item().Text(data.VendorName ?? "—").FontSize(11).Bold().FontColor(Ink);
                    if (!string.IsNullOrEmpty(data.SapVendorNumber))
                        c.Item().Text($"SAP Vendor {data.SapVendorNumber}").FontSize(9).FontColor(InkDim);
                });

                row.RelativeItem(3).Column(c =>
                {
                    c.Item().Text("ORDERED BY").FontSize(8).Bold().FontColor(InkDim);
                    c.Item().Text(KongsbergName).FontSize(10).Bold().FontColor(Ink);
                    c.Item().Text($"{KongsbergStreet}\n{KongsbergCity}, {KongsbergPostcode}\n{KongsbergCountry}").FontSize(9).FontColor(InkDim);
                });

                row.RelativeItem(2).Column(c =>
                {
                    c.Item().Text("DATE").FontSize(8).Bold().FontColor(InkDim);
                    c.Item().Text(FmtDate(data.PoDate)).FontSize(10).FontColor(Ink);
                    if (!string.IsNullOrEmpty(data.Currency))
                    {
                        c.Item().PaddingTop(6).Text("CURRENCY").FontSize(8).Bold().FontColor(InkDim);
                        c.Item().Text(data.Currency).FontSize(10).FontColor(Ink);
                    }
                    if (!string.IsNullOrEmpty(data.Incoterms))
                    {
                        c.Item().PaddingTop(6).Text("INCOTERMS").FontSize(8).Bold().FontColor(InkDim);
                        c.Item().Text(data.Incoterms).FontSize(10).FontColor(Ink);
                    }
                });
            });
        });
    }

    // EXW items are collected from the vendor's own site, not delivered to Kongsberg — the
    // meaningful date is when goods must be ready for collection (the caller is responsible for
    // putting the right underlying date into Item.DeliveryDate), so the column relabels rather
    // than reusing "Delivery Date" with a different meaning underneath. Only relabels when EVERY
    // item on the PO is EXW (one PO is always one vendor / one incoterm).
    private static void DrawItemsTable(IContainer container, IReadOnlyList<PoPdfItem> items, string deliveryLabel, bool hasPrice, string? currency)
    {
        container.Table(table =>
        {
            table.ColumnsDefinition(c =>
            {
                c.RelativeColumn(0.6f); // Item
                c.RelativeColumn(1.4f); // Material
                c.RelativeColumn(2f);   // Description
                c.RelativeColumn(0.9f); // Qty
                c.RelativeColumn(0.6f); // UOM
                c.RelativeColumn(1.3f); // Delivery
                if (hasPrice) c.RelativeColumn(1.3f); // Price
            });

            void HeaderCell(string label, bool alignRight = false) =>
                table.Cell().Background(HeaderFill).Padding(4).Text(t => { var s = t.Span(label.ToUpperInvariant()).FontSize(8).Bold().FontColor("#374151"); if (alignRight) t.AlignRight(); });

            HeaderCell("Item");
            HeaderCell("Material");
            HeaderCell("Description");
            HeaderCell("Qty", alignRight: true);
            HeaderCell("UOM");
            HeaderCell(deliveryLabel);
            if (hasPrice) HeaderCell("Price", alignRight: true);

            if (items.Count == 0)
            {
                table.Cell().ColumnSpan((uint)(hasPrice ? 7 : 6)).Padding(6).Text("No line items.").FontSize(9).FontColor(InkDim);
                return;
            }

            foreach (var it in items)
            {
                var price = FmtPrice(it.NetPrice, currency) ?? "Per SAP condition";

                DataCell(table, it.PoItemNumber);
                DataCell(table, it.Material ?? "");
                DataCell(table, it.MaterialText ?? "");
                DataCell(table, FmtQty(it.Quantity), alignRight: true);
                DataCell(table, it.Uom);
                DataCell(table, FmtDate(it.DeliveryDate));
                if (hasPrice) DataCell(table, price, alignRight: true);
            }
        });
    }

    private static void DataCell(QuestPDF.Fluent.TableDescriptor table, string value, bool alignRight = false)
    {
        var cell = table.Cell().BorderBottom(0.5f).BorderColor(Rule).Padding(4);
        var text = cell.Text(value).FontSize(8.5f).FontColor(Ink);
        if (alignRight) text.AlignRight();
    }

    private static void DrawTermsAndConditions(IContainer container)
    {
        container.Column(col =>
        {
            col.Item().BorderTop(2).BorderColor(BrandBlue);
            col.Item().PaddingTop(6).Text("TERMS & CONDITIONS").FontSize(8).Bold().FontColor(Ink);
            col.Item().PaddingTop(4).Text(TermsAndConditions).FontSize(7.5f).FontColor(InkDim).LineHeight(1.2f);
            col.Item().PaddingTop(8).BorderTop(2).BorderColor(BrandBlue);
        });
    }

    private static void DrawSupplierNoticeAndSignOff(IContainer container, string? purchaserName)
    {
        container.Column(col =>
        {
            col.Item().Text(SupplierNotice).FontSize(8).FontColor(Ink).LineHeight(1.3f);
            col.Item().PaddingTop(16).Text("With regards").FontSize(8).FontColor(Ink);
            col.Item().PaddingTop(4).Text(KongsbergName).FontSize(9).Bold().FontColor(Ink);
            col.Item().PaddingTop(24).Text(purchaserName ?? "—").FontSize(8).FontColor(Ink);
            col.Item().Text("Purchaser").FontSize(7.5f).FontColor(InkDim);
        });
    }

    private static void DrawFooter(IContainer container)
    {
        container.BorderTop(1).BorderColor(Rule).PaddingTop(6).Row(row =>
        {
            row.RelativeItem().Text(t =>
            {
                t.Span($"{KongsbergName} · {KongsbergStreet}, {KongsbergCity} {KongsbergPostcode} · VAT {KongsbergVat} · Generated {DateTime.Now:dd MMM yyyy} · Page ")
                    .FontSize(7).FontColor(InkDim);
                t.CurrentPageNumber().FontSize(7).FontColor(InkDim);
                t.Span(" of ").FontSize(7).FontColor(InkDim);
                t.TotalPages().FontSize(7).FontColor(InkDim);
            });
        });
    }
}
