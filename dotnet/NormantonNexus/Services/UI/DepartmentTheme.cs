namespace NormantonNexus.Services.UI;

/// <summary>
/// Per-department accent colour + icon, shared by the Hub's department cards
/// (Pages/Index.cshtml) and every inner page's header dept-badge
/// (Pages/Shared/_Layout.cshtml) — matches the Node app's own convention of
/// each department CSS file declaring its own --accent while sharing the
/// same component vocabulary (see private/css/warehouse.css vs landing.css).
/// Looked up by the same display-name string every page already sets via
/// ViewData["Department"], so no per-page changes were needed to wire this
/// up — the display names are a small, fixed, already-stable set.
/// </summary>
public static class DepartmentTheme
{
    public sealed record Entry(string Accent, string Accent2, string AccentDim, string IconSvg);

    private const string ProductionIcon = """<ellipse cx="14" cy="7" rx="8" ry="3" stroke="currentColor" stroke-width="1.8"/><path d="M6 7v14c0 1.66 3.58 3 8 3s8-1.34 8-3V7" stroke="currentColor" stroke-width="1.8"/><path d="M6 14c0 1.66 3.58 3 8 3s8-1.34 8-3" stroke="currentColor" stroke-width="1.8"/>""";
    private const string WarehouseIcon = """<path d="M3 8l9-5 9 5-9 5-9-5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M3 8v8l9 5 9-5V8" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 13v8" stroke="currentColor" stroke-width="1.8"/>""";
    private const string LogisticsIcon = """<rect x="2" y="9" width="12" height="8" rx="1" stroke="currentColor" stroke-width="1.8"/><path d="M14 12h4l4 3v2h-8v-5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="7" cy="19" r="1.6" stroke="currentColor" stroke-width="1.6"/><circle cx="18" cy="19" r="1.6" stroke="currentColor" stroke-width="1.6"/>""";
    private const string QualityIcon = """<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>""";
    private const string EngineeringIcon = """<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/><path d="M12 3v2.4M12 18.6V21M21 12h-2.4M5.4 12H3M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7M18.4 18.4l-1.7-1.7M7.3 7.3 5.6 5.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>""";
    private const string SalesIcon = """<path d="M3 17l5-6 4 3 6-8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 6h5v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>""";
    private const string FinanceIcon = """<circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v10M15 9.5c0-1.4-1.3-2.2-3-2.2s-3 .9-3 2.1c0 1.3 1.1 1.8 3 2.1s3 .9 3 2.2c0 1.2-1.3 2.1-3 2.1s-3-.8-3-2.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>""";
    private const string ManagementIcon = """<rect x="3" y="3" width="7" height="7" rx="1.3" stroke="currentColor" stroke-width="1.8"/><rect x="14" y="3" width="7" height="7" rx="1.3" stroke="currentColor" stroke-width="1.8"/><rect x="3" y="14" width="7" height="7" rx="1.3" stroke="currentColor" stroke-width="1.8"/><rect x="14" y="14" width="7" height="7" rx="1.3" stroke="currentColor" stroke-width="1.8"/>""";
    private const string AdminIcon = """<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="11" r="1.6" stroke="currentColor" stroke-width="1.6"/><path d="M12 12.6V15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>""";

    private static readonly IReadOnlyDictionary<string, Entry> ByDisplayName = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase)
    {
        ["Production"] = new("#2563EB", "#1D4ED8", "#DBEAFE", ProductionIcon),
        ["Warehouse"] = new("#7C3AED", "#6D28D9", "rgba(124,58,237,0.08)", WarehouseIcon),
        ["Logistics"] = new("#0891B2", "#0E7490", "rgba(8,145,178,0.08)", LogisticsIcon),
        ["Quality"] = new("#059669", "#047857", "#D1FAE5", QualityIcon),
        ["Engineering"] = new("#EA580C", "#C2410C", "rgba(234,88,12,0.08)", EngineeringIcon),
        ["Sales"] = new("#DB2777", "#BE185D", "rgba(219,39,119,0.08)", SalesIcon),
        ["Finance"] = new("#0D9488", "#0F766E", "rgba(13,148,136,0.08)", FinanceIcon),
        ["Management"] = new("#4F46E5", "#4338CA", "rgba(79,70,229,0.08)", ManagementIcon),
        ["Admin"] = new("#2563EB", "#1D4ED8", "#DBEAFE", AdminIcon),
    };

    /// <summary>Null for the Hub itself ("Normanton Nexus") and any other page with no department badge — those pages fall back to the plain header (logo + brand name only), matching Node's own landing.html.</summary>
    public static Entry? For(string? departmentDisplayName) =>
        departmentDisplayName is not null && ByDisplayName.TryGetValue(departmentDisplayName, out var entry) ? entry : null;
}
