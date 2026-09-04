namespace NormantonNexus.Services;

/// <summary>
/// C# equivalent of shipmentmain.js's getLogisticsSettings() — this port
/// only covers the fields Sub-phase 8a.1 (shipment lifecycle core) needs
/// (the fixed "origin" address stamped onto every outbound shipment, and
/// the export-folder root used to build a shipment's on-disk path). The
/// SMTP/ClearPort settings live in Node's same function but are deferred
/// to whichever later sub-slice (8a.4 email, 8a.5 customs) actually needs
/// them — added to this same options class when that slice lands, not
/// speculatively now. Defaults mirror Node's own hardcoded fallbacks
/// exactly (Kongsberg Actuation System Ltd's real registered address).
/// </summary>
public sealed class LogisticsOptions
{
    public const string SectionName = "Logistics";

    public string ExportRoot { get; set; } = "exports/customer-invoices";
    public long? OriginId { get; set; }
    public string OriginName { get; set; } = "Kongsberg Actuation System Ltd";
    public string OriginStreet { get; set; } = "Euroflex Centre, Foxbridge Way";
    public string OriginCity { get; set; } = "Normanton";
    public string OriginPostCode { get; set; } = "WF6 1TN";
    public string OriginCountry { get; set; } = "GB";
}
