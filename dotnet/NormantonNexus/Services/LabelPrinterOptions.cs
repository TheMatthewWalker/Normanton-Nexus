namespace NormantonNexus.Services;

/// <summary>
/// Network label printers — C# equivalent of config.json's top-level
/// `printers` array (config.js's printersConfig). Bound under a wrapping
/// "LabelPrinters" section (appsettings.json) rather than a bare root-level
/// array, matching every other Options-bound config in this app.
/// </summary>
public sealed class LabelPrinterOptions
{
    public const string SectionName = "LabelPrinters";

    public List<LabelPrinterConfig> Printers { get; set; } = [];
}

public sealed class LabelPrinterConfig
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Host { get; set; } = "";
    public int Port { get; set; } = 9100;
    public string PaperSize { get; set; } = "A5";
}
