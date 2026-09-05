namespace NormantonNexus.Services;

/// <summary>
/// C# equivalent of shipmentmain.js's getLogisticsSettings() — covers the
/// fields Sub-phases 8a.1-8a.4 need (the fixed "origin" address stamped
/// onto every outbound shipment, the export-folder root used to build a
/// shipment's on-disk path, and the SMTP relay settings for the collection
/// email). ClearPort settings live in Node's separate getClearPortSettings()
/// and are deferred to 8a.5, added to their own options class when that
/// slice lands. Defaults mirror Node's own hardcoded fallbacks exactly
/// (Kongsberg Actuation System Ltd's real registered address).
/// </summary>
public sealed class LogisticsOptions
{
    public const string SectionName = "Logistics";

    /// <summary>
    /// Must be a real absolute Windows/UNC path in production (enforced by
    /// ShipmentHelper.AssertValidExportRoot, matching Node's own
    /// assertValidExportRoot regex) — a bare relative string here would
    /// always fail that check the way Node's own equivalent would. The
    /// default mirrors Node's own fallback (`path.join(process.cwd(),
    /// 'exports', 'customer-invoices')`) by resolving against
    /// AppContext.BaseDirectory (this app's own analog of process.cwd()
    /// under IIS) rather than hardcoding a relative string that could
    /// never actually pass validation.
    /// </summary>
    public string ExportRoot { get; set; } = Path.Combine(AppContext.BaseDirectory, "exports", "customer-invoices");

    public long? OriginId { get; set; }
    public string OriginName { get; set; } = "Kongsberg Actuation System Ltd";
    public string OriginStreet { get; set; } = "Euroflex Centre, Foxbridge Way";
    public string OriginCity { get; set; } = "Normanton";
    public string OriginPostCode { get; set; } = "WF6 1TN";
    public string OriginCountry { get; set; } = "GB";

    // ── SMTP (Sub-phase 8a.4) — mirrors getLogisticsSettings()'s `email`
    // block exactly, including the permissive smtpAllowInvalidCert default
    // (Node defaults it to `true`, not `false` — a self-signed/internal
    // relay cert is the expected case here, not the exception). Blank
    // SmtpHost/MailFrom is a valid, expected default (matches Node's own
    // `''` fallback) — ShipmentCollectionEmailHelper throws a 503
    // NexusBadGatewayException at send time if either is still unset,
    // rather than failing app startup over it.
    public string SmtpHost { get; set; } = "";
    public int SmtpPort { get; set; } = 25;
    public bool SmtpSecure { get; set; }
    public string SmtpUser { get; set; } = "";
    public string SmtpPass { get; set; } = "";
    public string SmtpHelloName { get; set; } = "localhost";
    public int SmtpConnectionTimeoutMs { get; set; } = 15000;
    public bool SmtpAllowInvalidCert { get; set; } = true;
    public string MailFrom { get; set; } = "";
    public List<string> MailCc { get; set; } = [];
    public List<string> MailBcc { get; set; } = [];

    // ── Inbound (Sub-phase 8b.4) — mirrors LOGISTICS_IMPORT_ROOT/LOGISTICS_PO_ROOT.
    // Same "must be a real absolute Windows/UNC path in production" contract as ExportRoot
    // (enforced by InboundShipmentHelper.AssertValidRoot), and same AppContext.BaseDirectory-based
    // default reasoning.

    /// <summary>Supplier invoice/paperwork uploads land at {ImportRoot}\{Year}\{MM}. {MonthName}\{ShipmentReference} - {SupplierName}\.</summary>
    public string ImportRoot { get; set; } = Path.Combine(AppContext.BaseDirectory, "imports", "inbound");

    /// <summary>Auto-generated PO PDFs (written by Sub-phase 8b.7's Create PO in SAP) land flat at {PoRoot}\{VendorName}\{PoNumber}.pdf — read here only, to auto-file a copy into a new shipment's import folder.</summary>
    public string PoRoot { get; set; } = Path.Combine(AppContext.BaseDirectory, "exports", "purchase-orders");
}
