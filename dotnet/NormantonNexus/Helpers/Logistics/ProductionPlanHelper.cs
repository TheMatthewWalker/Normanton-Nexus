using System.Globalization;
using System.Net;
using System.Text;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Printable Production Plan — Logistics Sub-phase 8b.6. Port of
/// buildProductionPlanHTML + GET /orderbook-breakdown/production-plan/print
/// in routes/performance.js. Bare, standalone HTML report (no app chrome),
/// same convention as Production's DrummingTicketHtmlHelper/LabelHtmlHelper
/// — auto-fires window.print() on load.
///
/// Scope: PTFE lines flagged Last Day = "x" in log.OrderBookLineNotes,
/// excluding anything also flagged Won't Get, sorted by Last Day Time.
/// Quantity is whatever's been uploaded as Expected to Invoice Qty for that
/// line (PlannedProductionQty), falling back to Order Qty if nothing's been
/// uploaded yet — the same figure the Data tab itself defaults to and the
/// Dashboard's Last Day cards are built from.
/// </summary>
internal static class ProductionPlanHelper
{
    private static readonly CultureInfo EnGb = CultureInfo.GetCultureInfo("en-GB");

    private static string Esc(string? s) => WebUtility.HtmlEncode(s ?? "");

    internal static async Task<IReadOnlyList<ProductionPlanLine>> BuildPlanAsync(INexusOperationsDb db, CancellationToken ct)
    {
        var breakdownTask = PerformanceDashboardHelper.GetOrderBookBreakdownAsync(db, ct);
        var notesTask = PerformanceDashboardHelper.ListOrderBookLineNotesAsync(db, ct);
        await Task.WhenAll(breakdownTask, notesTask);
        return BuildPlanFromRows(await breakdownTask, await notesTask);
    }

    internal static IReadOnlyList<ProductionPlanLine> BuildPlanFromRows(IReadOnlyList<OrderBookBreakdownRow> rows, IReadOnlyDictionary<string, OrderBookLineNote> notesByKey) =>
        rows
            .Where(r => r.ValueStream == "PTFE")
            .Select(r => (Row: r, Notes: notesByKey.GetValueOrDefault($"{r.ReferenceDocument}||{r.Material}")))
            .Where(x =>
                string.Equals(x.Notes?.LastDay?.Trim(), "x", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(x.Notes?.WontGet?.Trim(), "x", StringComparison.OrdinalIgnoreCase))
            .Select(x =>
            {
                var orderQty = x.Row.OrderQty;
                var orderValue = x.Row.OrderValue;
                var quantity = x.Notes?.PlannedProductionQty ?? orderQty;
                var value = orderQty > 0 ? quantity * (orderValue / orderQty) : 0m;
                var time = x.Notes?.LastDayTime ?? "";

                return new ProductionPlanLine(time, x.Row.CustomerName ?? x.Row.Customer ?? "", x.Row.Material ?? "", x.Row.MaterialText, quantity, value);
            })
            .OrderBy(p => ParseLastDayTimeMinutes(p.Time))
            .ThenBy(p => p.Time, StringComparer.Ordinal)
            .ToList();

    /// <summary>"15:00" -&gt; 900 (minutes since midnight) for sorting; blank or anything that doesn't start with H:MM sorts first — same "defaults to the Hour 0 bucket" convention as the Excel Value-by-Hour table.</summary>
    internal static int ParseLastDayTimeMinutes(string? text)
    {
        var match = System.Text.RegularExpressions.Regex.Match((text ?? "").Trim(), @"^(\d{1,2}):(\d{2})");
        if (!match.Success) return -1;
        if (!int.TryParse(match.Groups[1].Value, out var hours) || !int.TryParse(match.Groups[2].Value, out var minutes)) return -1;
        return hours * 60 + minutes;
    }

    internal static string BuildHtml(IReadOnlyList<ProductionPlanLine> plan)
    {
        var generatedAt = DateTime.Now.ToString("dd/MM/yyyy, HH:mm", EnGb);
        var totalQty = plan.Sum(p => p.Quantity);
        var totalValue = plan.Sum(p => p.Value);

        var rowsHtml = plan.Count > 0
            ? string.Concat(plan.Select(p => $"""
                <tr>
                  <td>{Esc(string.IsNullOrEmpty(p.Time) ? "—" : p.Time)}</td>
                  <td>{Esc(p.Customer)}</td>
                  <td>{Esc(p.Material)}{(string.IsNullOrEmpty(p.MaterialText) ? "" : $" — {Esc(p.MaterialText)}")}</td>
                  <td class="num">{p.Quantity.ToString("#,##0.###", EnGb)}</td>
                  <td class="num">£{p.Value.ToString("N2", EnGb)}</td>
                </tr>
                """))
            : """<tr><td colspan="5" class="empty">Nothing is currently flagged Last Day on the PTFE order book.</td></tr>""";

        var footerHtml = plan.Count > 0
            ? $"""<tfoot><tr><td colspan="3">Total</td><td class="num">{totalQty.ToString("#,##0.###", EnGb)}</td><td class="num">£{totalValue.ToString("N2", EnGb)}</td></tr></tfoot>"""
            : "";

        return $$"""
            <!DOCTYPE html>
            <html lang="en">
            <head>
            <meta charset="UTF-8">
            <title>Production Plan — Last Day of Month</title>
            <style>
              @page { size: A4 portrait; margin: 14mm; }
              * { box-sizing: border-box; }
              body { font-family: Arial, sans-serif; color: #0F172A; margin: 0; }
              h1 { font-size: 18px; margin: 0 0 2px; }
              .subtitle { font-size: 11px; color: #64748B; margin: 0 0 16px; }
              table { width: 100%; border-collapse: collapse; font-size: 11px; }
              th, td { border: 1px solid #CBD5E1; padding: 6px 8px; text-align: left; }
              th { background: #1F3864; color: #fff; font-size: 10px; text-transform: uppercase; letter-spacing: .03em; }
              td.num, th.num { text-align: right; white-space: nowrap; }
              tbody tr:nth-child(even) { background: #F1F5F9; }
              tfoot td { font-weight: 700; border-top: 2px solid #1F3864; }
              .empty { text-align: center; color: #64748B; font-style: italic; }
              @media print {
                .no-print { display: none; }
              }
              .no-print { margin-top: 16px; font-size: 11px; color: #64748B; }
            </style>
            </head>
            <body>
              <h1>Production Plan — Last Day of Month (PTFE)</h1>
              <p class="subtitle">Generated {{Esc(generatedAt)}} &middot; sorted by time &middot; {{plan.Count}} line(s)</p>
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Customer</th>
                    <th>Material</th>
                    <th class="num">Quantity</th>
                    <th class="num">Value</th>
                  </tr>
                </thead>
                <tbody>{{rowsHtml}}</tbody>
                {{footerHtml}}
              </table>
              <p class="no-print">This window should print automatically. If it doesn't, use your browser's Print command (Ctrl/Cmd+P).</p>
            <script>window.addEventListener('load', () => setTimeout(() => window.print(), 300));</script>
            </body>
            </html>
            """;
    }
}
