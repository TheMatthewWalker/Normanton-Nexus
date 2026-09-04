namespace NormantonNexus.Services;

/// <summary>
/// C# equivalent of shipmentmain.js's getLogisticsSettings() — this port
/// only covers the fields Sub-phase 8a.1/8a.2/8a.3 need (the fixed
/// "origin" address stamped onto every outbound shipment, and the
/// export-folder root used to build a shipment's on-disk path). The
/// SMTP/ClearPort settings live in Node's same function but are deferred
/// to whichever later sub-slice (8a.4 email, 8a.5 customs) actually needs
/// them — added to this same options class when that slice lands, not
/// speculatively now. Defaults mirror Node's own hardcoded fallbacks
/// exactly (Kongsberg Actuation System Ltd's real registered address).
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
}
