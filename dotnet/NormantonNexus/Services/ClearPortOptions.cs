namespace NormantonNexus.Services;

/// <summary>
/// C# equivalent of shipmentmain.js's getClearPortSettings() — Logistics
/// Sub-phase 8a.5c. Defaults mirror Node's own hardcoded fallbacks exactly
/// (including the real EORI/customs-office/location-of-goods codes this
/// company already uses in production). UNVERIFIED against the real
/// ClearPort API — no live ClearPort sandbox or credentials have been
/// reachable in any environment this port has been developed in; see
/// ClearPortClient's own header comment.
/// </summary>
public sealed class ClearPortOptions
{
    public const string SectionName = "ClearPort";

    public string ApiUrl { get; set; } = "https://api.clear-port.com";
    public string ApiToken { get; set; } = "";
    public bool Sandbox { get; set; }
    public string DefaultCommodityCode { get; set; } = "39173900";
    public string DefaultProcedure { get; set; } = "1040";
    public string DefaultAdditionalProcedure { get; set; } = "000";
    public string DefaultNatureOfTransaction { get; set; } = "11";
    public string DefaultCurrency { get; set; } = "GBP";
    public string DefaultPackageType { get; set; } = "PX";

    public string? DdpConsigneeName { get; set; }
    public string? DdpConsigneeStreetAndNumber { get; set; }
    public string? DdpConsigneeCityName { get; set; }
    public string? DdpConsigneePostcode { get; set; }
    public string DdpConsigneeCountryCode { get; set; } = "GB";

    public string Eori { get; set; } = "GB214987833000";
    public string LocationOfGoods { get; set; } = "GBAUDEUDEUDEUGVM";
    public string CustomsOfficeOfExit { get; set; } = "GB000060";
    public string Rrs01Description { get; set; } = "Haulier";
    public int ModeOfTransportAtBorder { get; set; } = 6;
    public int InlandModeOfTransport { get; set; } = 3;
    public int TypeOfTransportAtDeparture { get; set; } = 30;
    public string IdentityOfTransportAtDeparture { get; set; } = "UNKNOWN";
    public int TypeOfActiveMeansOfTransportAtBorder { get; set; } = 6;
    public string IdentityOfActiveMeansOfTransportAtBorder { get; set; } = "UNKNOWN";
    public string NationalityOfActiveMeansOfTransportAtBorder { get; set; } = "GB";
}
