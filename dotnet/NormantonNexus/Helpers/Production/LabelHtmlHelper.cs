using System.Net;
using System.Text;
using NormantonNexus.Models.Dto;

namespace NormantonNexus.Helpers.Production;

/// <summary>
/// Renders the browser-preview label page — port of buildHTML/
/// buildLabelsHTML/renderLabelDiv in routes/labels.js. Pure string
/// building (barcode PNGs come from LabelBarcodeHelper, already base64
/// data URIs) — no I/O, so unlike almost everything else SAP/SQL-facing in
/// this migration, this is fully unit-testable for real.
/// </summary>
internal static class LabelHtmlHelper
{
    private static readonly Dictionary<int, (string Text, string Bg)> StatusBadge = new()
    {
        [1] = ("OPEN", "#d97706"),
        [2] = ("RUNNING", "#0d9488"),
        [3] = ("ON HOLD", "#6b7280"),
        [4] = ("COMPLETE", "#0d9488"),
        [5] = ("CANCELLED", "#dc2626"),
        [6] = ("BACKFLUSH FAILED", "#dc2626"),
    };

    private static string Esc(string? s) => WebUtility.HtmlEncode(s ?? "");

    private static string FmtLabel(DateTime? dt) =>
        dt is null ? "—" : dt.Value.ToString("dd MMM yyyy, HH:mm", System.Globalization.CultureInfo.GetCultureInfo("en-GB"));

    private static string BcImg(string? dataUri, int heightMm) =>
        dataUri is null ? "" : $"""<img src="{dataUri}" style="display:block;height:{heightMm}mm;width:auto;max-width:100%">""";

    /// <summary>One label's &lt;div class="label"&gt;...&lt;/div&gt; block — split out so a Mixing ticket run (multiple tubs) can render N of these into one preview page, same as Node's renderLabelDiv.</summary>
    private static string RenderLabelDiv(LabelData data)
    {
        var isComplete = data.Status == 4;
        var (badgeText, badgeBg) = StatusBadge.TryGetValue(data.Status, out var b) ? b : ($"STATUS {data.Status}", "#6b7280");

        var bcRef = LabelBarcodeHelper.BuildDataUri(data.BatchRef);
        var bcMat = LabelBarcodeHelper.BuildDataUri(data.Material);
        var bcSap = data.SapMatDoc is not null ? LabelBarcodeHelper.BuildDataUri(data.SapMatDoc) : null;

        var primaryOp = data.Operators.FirstOrDefault(o => o.IsPrimary) ?? data.Operators.FirstOrDefault();
        var opList = isComplete
            ? string.Join(", ", data.Operators.Select(o => Esc(o.DisplayName ?? o.Username)))
            : Esc(primaryOp?.DisplayName ?? primaryOp?.Username ?? "—");
        var dateLabel = isComplete ? "COMPLETED" : "CREATED";
        var dateVal = FmtLabel(isComplete ? data.CompletedAt : data.CreatedAt);

        string traceText;
        if (data.ProcessCode == "MX")
        {
            var parts = new List<string>();
            if (!string.IsNullOrEmpty(data.SupplierBatchNo)) parts.Add($"Supplier Batch: {Esc(data.SupplierBatchNo)}");
            if (!string.IsNullOrEmpty(data.SupplierTubNo)) parts.Add($"Tub No: {Esc(data.SupplierTubNo)}");
            traceText = parts.Count > 0 ? string.Join(" &nbsp;&nbsp; ", parts) : "—";
        }
        else
        {
            traceText = data.ParentBatches.Count > 0 ? string.Join(" &nbsp;&nbsp; ", data.ParentBatches.Select(Esc)) : "—";
        }

        var qLabel = data.Uom == "KG" ? "WEIGHT (KG)" : "LENGTH (M)";
        var qValue = data.Quantity is not null ? $"{data.Quantity.Value:F3} {Esc(data.Uom)}" : "—";

        var completionSection = "";
        if (isComplete)
        {
            var sb = new StringBuilder();
            sb.Append($"""
                <div class="divider"></div>
                <div>
                  <div class="lbl">{qLabel}</div>
                  <div class="qty">{qValue}</div>
                </div>
                """);
            if (!string.IsNullOrEmpty(data.Notes))
            {
                sb.Append($"""

                    <div class="divider"></div>
                    <div class="lbl">NOTES</div>
                    <div class="notes">{Esc(data.Notes)}</div>
                    """);
            }
            completionSection = sb.ToString();
        }

        var sapSection = isComplete && data.SapMatDoc is not null
            ? $"""
                <div class="lbl">SAP MATERIAL DOCUMENT</div>
                <div class="mix-id">{Esc(data.SapMatDoc)}</div>
                {BcImg(bcSap, 13)}
                <div class="divider"></div>
                """
            : "";

        var machineSection = data.Machine is not null
            ? $"""
                <div class="lbl">MACHINE</div>
                <div class="mach-val">{Esc(data.Machine)}</div>
                """
            : "";

        return $"""
            <div class="label">
              <div class="header">
                <div>
                  <div class="co-name">KONGSBERG AUTOMOTIVE</div>
                  <div class="co-proc">{Esc(data.ProcessName.ToUpperInvariant())} — PRODUCTION ENTRY</div>
                </div>
                <div class="badge" style="background:{badgeBg}">{Esc(badgeText)}</div>
              </div>
              <div class="body">
                <div class="two-col">
                  <div class="col">
                    <div class="lbl">BATCH REFERENCE</div>
                    <div class="mix-id">{Esc(data.BatchRef)}</div>
                    {BcImg(bcRef, 13)}
                    <div class="divider"></div>
                    <div class="lbl">MATERIAL</div>
                    <div class="mat-id">{Esc(data.Material)}</div>
                    {BcImg(bcMat, 9)}
                  </div>
                  <div class="col">
                    {sapSection}
                    <div class="lbl">{(isComplete ? "OPERATORS" : "OPERATOR")}</div>
                    <div class="op-val">{opList}</div>
                    {machineSection}
                    <div class="lbl">{dateLabel}</div>
                    <div class="date-val">{Esc(dateVal)}</div>
                  </div>
                </div>
                <div class="divider"></div>
                <div>
                  <div class="lbl">INPUT BATCHES</div>
                  <div class="trace-val">{traceText}</div>
                </div>
                {completionSection}
              </div>
              <div class="footer">Printed {Esc(FmtLabel(DateTime.Now))} &nbsp;·&nbsp; {Esc(data.BatchRef)}</div>
            </div>
            """;
    }

    /// <summary>Wraps N label divs (one per prod.MixingTubs row for an MX run, or just one for every other process) in a single preview page — shared head/style/print-trigger, one .label per printed page via the @media print page-break rule below. Mirrors Node's buildLabelsHTML exactly.</summary>
    internal static string RenderPage(IReadOnlyList<LabelData> dataArray)
    {
        var divs = string.Join("\n", dataArray.Select(RenderLabelDiv));
        var first = dataArray[0];
        var title = dataArray.Count > 1
            ? $"{first.BatchRef.Split("-T")[0]} — {first.ProcessName} Labels ({dataArray.Count})"
            : $"{first.BatchRef} — {first.ProcessName} Label";

        return $$"""
            <!DOCTYPE html>
            <html lang="en">
            <head>
            <meta charset="UTF-8">
            <title>{{Esc(title)}}</title>
            <style>
              @page { size: 210mm 148mm; margin: 0; }
              *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
              html, body {
                width: 210mm; overflow: visible;
                font-family: Helvetica Neue, Helvetica, Arial, sans-serif;
                background: #fff;
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
              }
              .label { width: 210mm; height: 148mm; display: flex; flex-direction: column; overflow: hidden; }
              .header {
                background: #0d4c45; color: #fff;
                padding: 6px 12px;
                display: flex; justify-content: space-between; align-items: center;
                flex-shrink: 0;
              }
              .co-name { font-size: 11pt; font-weight: 700; letter-spacing: 0.02em; }
              .co-proc { font-size: 7.5pt; opacity: 0.75; margin-top: 2px; }
              .badge   { font-size: 7pt; font-weight: 700; color: #fff; padding: 3px 9px; border-radius: 4px; white-space: nowrap; }
              .body    { flex: 1; overflow: hidden; padding: 6px 12px 2px; display: flex; flex-direction: column; gap: 4px; }
              .lbl     { font-size: 5.5pt; font-weight: 700; color: #6b7280; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 2px; }
              .divider { border: none; border-top: 0.5px solid #d1d5db; margin: 2px 0; flex-shrink: 0; }
              .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
              .col     { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
              .mix-id  { font-size: 32pt; font-weight: 800; letter-spacing: 0.02em; line-height: 1.05; white-space: nowrap; overflow: hidden; }
              .mat-id  { font-size: 26pt; font-weight: 800; letter-spacing: 0.02em; line-height: 1.05; white-space: nowrap; overflow: hidden; margin-top: 2px; }
              .mach-val { font-size: 9pt; font-weight: 700; }
              .op-val   { font-size: 8pt; }
              .date-val { font-size: 8pt; }
              .trace-val { font-size: 8pt; }
              .qty      { font-size: 30pt; font-weight: 700; color: #0d4c45; margin-top: 1px; }
              .notes    { font-size: 7.5pt; }
              .footer   { border-top: 2px solid #0d4c45; padding: 2px 12px; font-size: 6pt; color: #9ca3af; flex-shrink: 0; }
              @media screen {
                html, body { display: flex; flex-direction: column; align-items: center; background: #e5e7eb; }
                .label { margin: 10px; box-shadow: 0 4px 20px rgba(0,0,0,0.2); }
              }
              @media print {
                .label { page-break-after: always; }
                .label:last-child { page-break-after: auto; }
              }
            </style>
            </head>
            <body>
            {{divs}}
            <script>window.addEventListener('load', () => setTimeout(() => window.print(), 300));</script>
            </body>
            </html>
            """;
    }
}
