using NormantonNexus.Models.Dto;
using QuestPDF.Fluent;
using QuestPDF.Helpers;
using QuestPDF.Infrastructure;

namespace NormantonNexus.Helpers.Production;

/// <summary>
/// Server-side label PDF generation for network printing — port of
/// buildPDF/buildLabelsPDF/drawLabelPage in routes/labels.js (pdfkit).
///
/// DEVIATION, deliberate: this is NOT a pixel-for-pixel port of Node's
/// imperative PDFKit drawing (absolute x/y cursors, hand-measured font
/// sizes per field). QuestPDF's layout model is declarative
/// (Row/Column/constraint-based), so the same content and grouping —
/// header bar, two-column Batch Reference+barcode / Material+barcode on
/// the left and SAP Material Document+barcode / Operators / Machine /
/// Completed on the right, footer — is reproduced using QuestPDF's own
/// idiomatic elements rather than fighting its layout engine to replicate
/// PDFKit's coordinate math. This also can't be visually verified in this
/// sandbox (no PDF viewer, no real printer) — chasing pixel fidelity
/// against Node's hand-tuned measurements would be false precision without
/// a way to confirm it landed correctly. LabelPdfHelperTests instead
/// verifies real, checkable structure: valid PDF bytes, correct page
/// count (one page per label — one per Mixing tub, same as Node's one-
/// tcpPrint-job-per-batch design), and that generation doesn't throw for
/// every real data shape (open/complete/no-machine/no-SAP-doc/A4-vs-A5).
/// </summary>
internal static class LabelPdfHelper
{
    // Belt-and-braces alongside Program.cs's own License assignment: a test
    // project (or any other caller that never runs Program.cs's startup
    // code) would otherwise hit QuestPDF's license-validation exception on
    // the very first GeneratePdf() call. An EXPLICIT static constructor
    // (unlike a field initializer, which the runtime may defer under the
    // "beforefieldinit" optimization) is guaranteed to run before this
    // class's first use, no matter which static member is called first.
    static LabelPdfHelper()
    {
        QuestPDF.Settings.License = QuestPDF.Infrastructure.LicenseType.Community;
    }

    private static readonly Dictionary<int, (string Text, string Bg)> StatusBadge = new()
    {
        [1] = ("OPEN", "#d97706"),
        [2] = ("RUNNING", "#0d9488"),
        [3] = ("ON HOLD", "#6b7280"),
        [4] = ("COMPLETE", "#0d9488"),
        [5] = ("CANCELLED", "#dc2626"),
        [6] = ("BACKFLUSH FAILED", "#dc2626"),
    };

    private const string Teal = "#0d4c45";
    private const string Ink = "#111827";
    private const string MutedLabel = "#6b7280";
    private const string DividerColor = "#d1d5db";
    private const string FooterGrey = "#9ca3af";

    /// <summary>
    /// One label per page. Mirrors Node's buildLabelsPDF — one PDFDocument/
    /// tcpPrint job per batch, one page per tub for a Mixing run, one page
    /// for every other process.
    ///
    /// FURTHER SIMPLIFICATION vs. Node: content auto-sizes to whatever it
    /// actually needs rather than being pinned to a fixed 420pt/148mm
    /// height the way PDFKit's absolute-coordinate drawing was. This means
    /// an A4 label fills more of the page vertically than Node's version
    /// (which deliberately kept the label in the top half on A4 trays,
    /// leaving the rest blank) — a real, deliberate difference, not a bug:
    /// QuestPDF enforces strict content-must-fit constraints (unlike a
    /// CSS overflow:hidden box or PDFKit's own tolerance for content simply
    /// running past a fixed box), so a hand-tuned fixed height risked a
    /// DocumentLayoutException the moment any field's real-world content
    /// was longer than the values this was manually checked against — with
    /// no PDF viewer in this sandbox to catch that ahead of a real deploy.
    /// </summary>
    internal static byte[] BuildLabelsPdf(IReadOnlyList<LabelData> dataArray, string paperSize)
    {
        var isA4 = string.Equals(paperSize, "A4", StringComparison.OrdinalIgnoreCase);

        var document = QuestPDF.Fluent.Document.Create(container =>
        {
            foreach (var data in dataArray)
            {
                container.Page(page =>
                {
                    page.Size(isA4 ? PageSizes.A4 : PageSizes.A5.Landscape());
                    // Real A4 printers have a hardware minimum margin
                    // (~4-5mm) the print engine can't image into — without
                    // this, a header drawn starting at the very top edge
                    // gets silently clipped on A4 trays (never a problem on
                    // A5 die-cut/thermal label stock, which images edge-to-
                    // edge). Mirrors Node's TOP_SAFE_MARGIN exactly.
                    page.MarginTop(isA4 ? 5.6f : 0, Unit.Millimetre);
                    page.Content().Element(c => DrawLabel(c, data));
                });
            }
        });

        return document.GeneratePdf();
    }

    internal static byte[] BuildSingleLabelPdf(LabelData data, string paperSize) =>
        BuildLabelsPdf([data], paperSize);

    private static void DrawLabel(IContainer container, LabelData data)
    {
        var isComplete = data.Status == 4;
        var (badgeText, badgeBg) = StatusBadge.TryGetValue(data.Status, out var b) ? b : ($"STATUS {data.Status}", MutedLabel);

        container.Column(col =>
        {
            col.Spacing(4);

            // ── Header ───────────────────────────────────────────────────
            col.Item().Background(Teal).Padding(8).Row(row =>
            {
                row.RelativeItem().Column(header =>
                {
                    header.Item().Text("KONGSBERG AUTOMOTIVE").FontSize(12).Bold().FontColor(Colors.White);
                    header.Item().Text($"{data.ProcessName.ToUpperInvariant()} — PRODUCTION ENTRY").FontSize(8).FontColor(Colors.White);
                });
                row.ConstantItem(140).AlignRight().AlignMiddle()
                    .Background(badgeBg).PaddingVertical(4).PaddingHorizontal(9)
                    .Text(badgeText).FontSize(7).Bold().FontColor(Colors.White);
            });

            // ── Two-column body ─────────────────────────────────────────
            col.Item().PaddingHorizontal(12).Row(row =>
            {
                row.Spacing(12);
                row.RelativeItem().Column(left =>
                {
                    left.Spacing(2);
                    left.Item().Text("BATCH REFERENCE").FontSize(5.5f).Bold().FontColor(MutedLabel);
                    left.Item().Text(data.BatchRef).FontSize(22).Bold().FontColor(Ink);
                    AddBarcode(left, data.BatchRef, 65);
                    left.Item().PaddingVertical(2).LineHorizontal(0.5f).LineColor(DividerColor);
                    left.Item().Text("MATERIAL").FontSize(5.5f).Bold().FontColor(MutedLabel);
                    left.Item().Text(data.Material).FontSize(18).Bold().FontColor(Ink);
                    AddBarcode(left, data.Material, 50);
                });

                row.RelativeItem().Column(right =>
                {
                    right.Spacing(2);
                    if (isComplete && data.SapMatDoc is not null)
                    {
                        right.Item().Text("SAP MATERIAL DOCUMENT").FontSize(5.5f).Bold().FontColor(MutedLabel);
                        right.Item().Text(data.SapMatDoc).FontSize(22).Bold().FontColor(Ink);
                        AddBarcode(right, data.SapMatDoc, 65);
                        right.Item().PaddingVertical(2).LineHorizontal(0.5f).LineColor(DividerColor);
                    }

                    var primaryOp = data.Operators.FirstOrDefault(o => o.IsPrimary) ?? data.Operators.FirstOrDefault();
                    var opList = isComplete
                        ? string.Join(", ", data.Operators.Select(o => o.DisplayName ?? o.Username))
                        : (primaryOp?.DisplayName ?? primaryOp?.Username ?? "—");

                    right.Item().Text(isComplete ? "OPERATORS" : "OPERATOR").FontSize(5.5f).Bold().FontColor(MutedLabel);
                    right.Item().Text(opList).FontSize(11).FontColor(Ink);

                    if (data.Machine is not null)
                    {
                        right.Item().Text("MACHINE").FontSize(5.5f).Bold().FontColor(MutedLabel);
                        right.Item().Text(data.Machine).FontSize(11).Bold().FontColor(Ink);
                    }

                    right.Item().Text(isComplete ? "COMPLETED" : "CREATED").FontSize(5.5f).Bold().FontColor(MutedLabel);
                    right.Item().Text(FmtLabel(isComplete ? data.CompletedAt : data.CreatedAt)).FontSize(11).FontColor(Ink);
                });
            });

            // ── Input batches (full width) ──────────────────────────────
            col.Item().PaddingHorizontal(12).LineHorizontal(0.5f).LineColor(DividerColor);
            col.Item().PaddingHorizontal(12).Column(trace =>
            {
                trace.Item().Text("INPUT BATCHES").FontSize(5.5f).Bold().FontColor(MutedLabel);
                trace.Item().Text(TraceText(data)).FontSize(8).FontColor(Ink);
            });

            // ── Completion section ───────────────────────────────────────
            if (isComplete)
            {
                col.Item().PaddingHorizontal(12).LineHorizontal(0.5f).LineColor(DividerColor);
                col.Item().PaddingHorizontal(12).Column(qtyCol =>
                {
                    var qLabel = data.Uom == "KG" ? "WEIGHT (KG)" : "LENGTH (M)";
                    var qValue = data.Quantity is not null ? $"{data.Quantity.Value:F3} {data.Uom}" : "—";
                    qtyCol.Item().Text(qLabel).FontSize(5.5f).Bold().FontColor(MutedLabel);
                    qtyCol.Item().Text(qValue).FontSize(20).Bold().FontColor(Teal);
                });

                if (!string.IsNullOrEmpty(data.Notes))
                {
                    col.Item().PaddingHorizontal(12).LineHorizontal(0.5f).LineColor(DividerColor);
                    col.Item().PaddingHorizontal(12).Column(notesCol =>
                    {
                        notesCol.Item().Text("NOTES").FontSize(5.5f).Bold().FontColor(MutedLabel);
                        notesCol.Item().Text(data.Notes).FontSize(8).FontColor(Ink);
                    });
                }
            }

            // ── Footer ───────────────────────────────────────────────────
            col.Item().PaddingTop(4).BorderTop(2).BorderColor(Teal).PaddingHorizontal(12).PaddingTop(2)
                .Text($"Printed {FmtLabel(DateTime.Now)}  ·  {data.BatchRef}").FontSize(6).FontColor(FooterGrey);
        });
    }

    /// <summary>
    /// Constrained by WIDTH (matching Node's own bcImg/renderedH — a fixed
    /// display width with height following the barcode's real aspect
    /// ratio), not height. An earlier version of this method fixed the
    /// HEIGHT instead and let width float, which is backwards: a long
    /// batch ref encodes to a wide, short barcode image, and fitting that
    /// to a tall target height blew the resulting width past the column's
    /// available space — QuestPDF (unlike PDFKit, which just lets an
    /// oversized image draw past its intended bounds) throws a
    /// DocumentLayoutException for that rather than silently overflowing,
    /// which is exactly what caught this before it ever reached a real
    /// deploy.
    /// </summary>
    private static void AddBarcode(ColumnDescriptor column, string? value, float widthMm)
    {
        var bytes = LabelBarcodeHelper.BuildPngBytes(value);
        if (bytes is null) return;
        column.Item().MaxWidth(widthMm, Unit.Millimetre).AlignLeft().Image(bytes).FitWidth();
    }

    private static string TraceText(LabelData data)
    {
        if (data.ProcessCode == "MX")
        {
            var parts = new List<string>();
            if (!string.IsNullOrEmpty(data.SupplierBatchNo)) parts.Add($"Supplier Batch: {data.SupplierBatchNo}");
            if (!string.IsNullOrEmpty(data.SupplierTubNo)) parts.Add($"Tub No: {data.SupplierTubNo}");
            return parts.Count > 0 ? string.Join("   ", parts) : "—";
        }
        return data.ParentBatches.Count > 0 ? string.Join("   ", data.ParentBatches) : "—";
    }

    private static string FmtLabel(DateTime? dt) =>
        dt is null ? "—" : dt.Value.ToString("dd MMM yyyy, HH:mm", System.Globalization.CultureInfo.GetCultureInfo("en-GB"));
}
