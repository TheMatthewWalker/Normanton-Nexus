using System.Globalization;
using System.Net;
using System.Text;
using NormantonNexus.Models.Dto;

namespace NormantonNexus.Helpers.Production;

/// <summary>
/// Renders the printable Drumming Ticket page — port of
/// buildDrummingTicketHTML in routes/productionnexus.js. Pure string
/// building, no I/O — same split as LabelHtmlHelper (data-fetch stays in
/// OrderLookupHelper, this class only turns already-loaded data into HTML).
/// Opened client-side via window.open(..., '_blank'), which auto-triggers
/// window.print() — prints to the operator's OS-default printer through
/// the browser's native dialog, NOT the network-printer TCP flow
/// LabelPrintHelper uses for production labels elsewhere in this app.
/// </summary>
internal static class DrummingTicketHtmlHelper
{
    private static readonly CultureInfo EnGb = CultureInfo.GetCultureInfo("en-GB");

    private static string Esc(string? s) => WebUtility.HtmlEncode(s ?? "");

    /// <summary>One numbered 3-column coil checklist table — 35 hand-fill slots (No / Coil / ID OK), matching the Excel Ticket tab's operator grid. Mirrors Node's coilCol exactly.</summary>
    private static string CoilCol(int start, int end)
    {
        var sb = new StringBuilder();
        for (var i = start; i <= end; i++)
        {
            sb.Append($"""
                          <tr><td class="num">{i}</td><td></td><td></td></tr>

                """);
        }

        return $"""
            <table class="coil-grid">
              <thead><tr><th>No</th><th>Coil</th><th>ID OK</th></tr></thead>
              <tbody>
            {sb}      </tbody>
            </table>
            """;
    }

    internal static string RenderPage(DrummingTicketData data)
    {
        var line = data.Line;
        var generatedAt = DateTime.Now.ToString("dd/MM/yyyy, HH:mm", EnGb);
        var orderRef = $"{line.ReferenceDocument}-{line.Item}";
        var sapInstructions = data.SapInstructions;
        var customerStandardInstructions = data.CustomerStandardInstructions;

        const int perCol = 12; // Math.ceil(35 / 3)
        var requiredQty = (line.RequiredQty ?? 0).ToString("#,##0.###", EnGb);

        return $$"""
            <!DOCTYPE html>
            <html lang="en">
            <head>
            <meta charset="UTF-8">
            <title>Drumming Ticket — {{Esc(orderRef)}}</title>
            <style>
              @page { size: A4 portrait; margin: 14mm; }
              * { box-sizing: border-box; }
              body { font-family: Arial, sans-serif; color: #0F172A; margin: 0; font-size: 12px; }
              h1 { font-size: 18px; margin: 0 0 2px; }
              .subtitle { font-size: 11px; color: #64748B; margin: 0 0 16px; }
              .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid #CBD5E1; margin-bottom: 14px; }
              .info-cell { border: 1px solid #CBD5E1; padding: 6px 10px; }
              .info-label { font-size: 9px; text-transform: uppercase; letter-spacing: .04em; color: #64748B; font-weight: 700; }
              .info-value { font-size: 13px; font-weight: 600; margin-top: 2px; }
              .info-value.blank { border-bottom: 1px solid #94A3B8; min-height: 16px; }
              .section-title { background: #1F3864; color: #fff; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; padding: 5px 10px; margin: 14px 0 0; }
              .section-body { border: 1px solid #CBD5E1; border-top: none; padding: 8px 10px; white-space: pre-wrap; min-height: 20px; }
              .section-body.empty { color: #94A3B8; font-style: italic; }
              .coils-wrap { display: flex; gap: 10px; margin-top: 14px; }
              table.coil-grid { border-collapse: collapse; font-size: 10px; flex: 1; }
              table.coil-grid th, table.coil-grid td { border: 1px solid #CBD5E1; padding: 2px 6px; text-align: left; }
              table.coil-grid th { background: #F1F5F9; font-size: 9px; text-transform: uppercase; }
              table.coil-grid td.num { text-align: center; color: #64748B; width: 20px; }
              .signoff-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 14px; }
              .signoff-cell { border-bottom: 1px solid #94A3B8; padding: 12px 4px 4px; }
              .signoff-label { font-size: 9px; text-transform: uppercase; letter-spacing: .04em; color: #64748B; }
              @media print { .no-print { display: none; } }
              .no-print { margin-top: 16px; font-size: 11px; color: #64748B; }
            </style>
            </head>
            <body>
              <h1>Drumming Ticket</h1>
              <p class="subtitle">Order {{Esc(orderRef)}} &middot; Generated {{Esc(generatedAt)}}</p>

              <div class="info-grid">
                <div class="info-cell"><div class="info-label">Customer</div><div class="info-value">{{Esc(line.Customer)}} — {{Esc(line.CustomerName ?? "")}}</div></div>
                <div class="info-cell"><div class="info-label">Customer Material</div><div class="info-value">{{Esc(line.CustomerMaterial is { Length: > 0 } ? line.CustomerMaterial : "—")}}</div></div>
                <div class="info-cell"><div class="info-label">Material</div><div class="info-value">{{Esc(line.Material)}} — {{Esc(line.MaterialText ?? "")}}</div></div>
                <div class="info-cell"><div class="info-label">Required Length</div><div class="info-value">{{requiredQty}} {{Esc(line.Uom ?? "")}}</div></div>
                <div class="info-cell"><div class="info-label">Packaging</div><div class="info-value blank">&nbsp;</div></div>
                <div class="info-cell"><div class="info-label">Packaging Barcode</div><div class="info-value blank">&nbsp;</div></div>
                <div class="info-cell"><div class="info-label">Batch Traceability Number</div><div class="info-value blank">&nbsp;</div></div>
                <div class="info-cell"><div class="info-label">Drum No</div><div class="info-value blank">&nbsp;</div></div>
              </div>

              <div class="section-title">Special Instructions</div>
              <div class="section-body">Order Number: {{Esc(orderRef)}}</div>
              <div class="section-title">Customer Requirement (SAP)</div>
              <div class="section-body {{(string.IsNullOrEmpty(sapInstructions) ? "empty" : "")}}">{{(string.IsNullOrEmpty(sapInstructions) ? "No special instructions held against this order in SAP." : Esc(sapInstructions))}}</div>
              <div class="section-title">Customer Standard Instructions</div>
              <div class="section-body {{(string.IsNullOrEmpty(customerStandardInstructions) ? "empty" : "")}}">{{(string.IsNullOrEmpty(customerStandardInstructions) ? "No standard instructions held for this customer." : Esc(customerStandardInstructions))}}</div>

              <div class="section-title">Operator Coil Checklist</div>
              <div class="section-body" style="padding-top:10px">
                <div class="coils-wrap">
                  {{CoilCol(1, perCol)}}
                  {{CoilCol(perCol + 1, perCol * 2)}}
                  {{CoilCol(perCol * 2 + 1, 35)}}
                </div>
                <div class="signoff-grid">
                  <div class="signoff-cell"><div class="signoff-label">Stripped By</div></div>
                  <div class="signoff-cell"><div class="signoff-label">Swaged By</div></div>
                  <div class="signoff-cell"><div class="signoff-label">No of Joints</div></div>
                  <div class="signoff-cell"><div class="signoff-label">Checked By</div></div>
                  <div class="signoff-cell"><div class="signoff-label">Date</div></div>
                  <div class="signoff-cell"><div class="signoff-label">Shift</div></div>
                </div>
              </div>

              <p class="no-print">This window should print automatically. If it doesn't, use your browser's Print command (Ctrl/Cmd+P).</p>
            <script>window.addEventListener('load', () => setTimeout(() => window.print(), 300));</script>
            </body>
            </html>
            """;
    }
}
