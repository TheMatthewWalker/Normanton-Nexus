using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Pure ClearPort export-declaration payload construction — Logistics
/// Sub-phase 8a.5c. Port of routes/shipmentmain.js's
/// buildClearPortShipmentPayload. No I/O of its own (no DB, no HTTP) —
/// everything it needs (the shipment context and the SAP customs data) is
/// fetched by its caller (ShipmentCustomsHelper), so this class is fully
/// unit-testable without a connection or a real ClearPort/SapServer.
///
/// Two confirmed Node oversights are deliberately NOT replicated literally
/// here, both flagged rather than silently "fixed" without comment:
///
/// 1. `declarant` is built from raw `process.env.LOGISTICS_ORIGIN_*` with
///    NO fallback (unlike `exporter`, built from the shipment's own
///    already-resolved origin fields) — if those specific env vars aren't
///    set, Node's declarant silently comes out all-null. This port uses
///    the same resolved `LogisticsOptions` origin fields for declarant as
///    for exporter (the sensible, almost-certainly-intended behavior —
///    the registered site address as both exporter and declarant, the
///    standard pattern for this kind of declaration), since a literal
///    "sometimes silently blank depending on unrelated env var naming"
///    behavior has no real production value worth preserving and this
///    whole route has never run against live ClearPort to confirm anyone
///    depends on the blank-declarant behavior specifically.
/// 2. `ducr` is built from raw `process.env.CLEARPORT_EORI` (again no
///    fallback), unlike every other EORI usage in the same function which
///    goes through `clearPort.eori`'s real default. If unset, Node's DUCR
///    would literally contain the string "undefined" — a misconfiguration
///    symptom, not an intended value. This port uses `ClearPortOptions.Eori`
///    (the resolved value, same default the rest of the payload already
///    uses) for consistency.
///
/// `Math.round(value, 2)` in Node is a genuine bug preserved exactly:
/// JavaScript's `Math.round` only ever takes one argument, so the second
/// `2` is silently ignored — `statisticalValue`/`totalInvoice` are
/// actually rounded to the nearest WHOLE number, not 2 decimal places.
/// `Math.Round(value, MidpointRounding.AwayFromZero)` reproduces this
/// (0 decimal places, round-half-up matching JS's Math.round instead of
/// C#'s own default round-half-to-even).
/// </summary>
internal static class ClearPortShipmentPayloadHelper
{
    internal static ClearPortExportRequest Build(ShipmentContext context, SapCustomsData sapData, ClearPortOptions clearPort, LogisticsOptions logistics)
    {
        var shipment = context.Shipment;
        var deliveries = context.Deliveries;

        if (deliveries.Count == 0)
            throw new NexusValidationException($"Shipment {shipment.ShipmentId} has no linked deliveries for customs submission.");
        if (sapData.LipsData.Count == 0)
            throw new NexusUnprocessableEntityException($"No SAP line items (LIPS) returned for shipment {shipment.ShipmentId}. Verify delivery numbers exist in SAP.");

        var shipmentRef = ShipmentHelper.FormatShipmentRef(shipment.ShipmentId);
        var originCountry = NormalizeCountryCode(shipment.OriginCountry, "GB");
        var destinationCountry = NormalizeCountryCode(shipment.DestinationCountry, "GB");
        var exporter = ToNameAndAddress(shipment.OriginName, shipment.OriginStreet, shipment.OriginCity, shipment.OriginPostCode, shipment.OriginCountry);
        var declarant = ToNameAndAddress(logistics.OriginName, logistics.OriginStreet, logistics.OriginCity, logistics.OriginPostCode, logistics.OriginCountry);
        var destinationConsignee = ToNameAndAddress(shipment.DestinationName, shipment.DestinationStreet, shipment.DestinationCity, shipment.DestinationPostCode, shipment.DestinationCountry);

        var marcMap = LastWinsMap(sapData.MarcData, r => (r.MaterialNumber ?? "").Trim());
        var vbfaMap = LastWinsMap(sapData.VbfaData, r => $"{r.DeliveryNumber}-{r.ItemNumber}");
        var likpMap = LastWinsMap(sapData.LikpData, r => (r.DeliveryNumber ?? "").Trim());

        // SAP delivery numbers can come back in several formats depending on
        // the SAP server: plain ID, "00" prefix, or 10-char zero-padded —
        // index under all three so the lookup below is format-agnostic.
        var deliveryBySapNumber = new Dictionary<string, ShipmentContextDeliveryRow>();
        foreach (var delivery in deliveries)
        {
            var id = delivery.DeliveryId.ToString();
            deliveryBySapNumber[id] = delivery;
            deliveryBySapNumber["00" + id] = delivery;
            deliveryBySapNumber[id.PadLeft(10, '0')] = delivery;
        }

        var lipsCountByDelivery = new Dictionary<string, int>();
        foreach (var line in sapData.LipsData)
        {
            var key = line.DeliveryNumber ?? "";
            lipsCountByDelivery[key] = lipsCountByDelivery.GetValueOrDefault(key) + 1;
        }

        var enrichedLines = sapData.LipsData.Select(line =>
        {
            var deliveryNumber = line.DeliveryNumber ?? "";
            marcMap.TryGetValue((line.MaterialNumber ?? "").Trim(), out var marc);
            vbfaMap.TryGetValue($"{deliveryNumber}-{line.ItemNumber}", out var vbfa);
            likpMap.TryGetValue(deliveryNumber, out var likp);
            deliveryBySapNumber.TryGetValue(deliveryNumber, out var delivery);
            var linesForDelivery = lipsCountByDelivery.GetValueOrDefault(deliveryNumber, 1);

            return new EnrichedLine(
                DeliveryNumber: deliveryNumber,
                InvoiceNumber: (vbfa?.InvoiceNumber ?? "").Trim(),
                CommodityCode: marc?.CommodityCode?.Trim() is { Length: > 0 } code ? code : clearPort.DefaultCommodityCode,
                CountryOfOrigin: NormalizeCountryCode(marc?.CountryOfOrigin, originCountry),
                Incoterms: (likp?.Incoterms ?? shipment.IncoTerms ?? "").Trim().ToUpperInvariant(),
                StatisticalValue: ParseEuropeanDecimal(vbfa?.StatisticalValue),
                GrossMass: delivery is not null ? delivery.GrossWeight / linesForDelivery : 0,
                NetMass: delivery is not null ? delivery.NetWeight / linesForDelivery : 0,
                PackageCount: delivery is not null ? delivery.PalletCount / linesForDelivery : 0);
        }).ToList();

        var groups = new Dictionary<string, LineGroup>();
        var groupOrder = new List<string>();
        foreach (var line in enrichedLines)
        {
            var key = $"{line.DeliveryNumber}|{line.CommodityCode}";
            if (!groups.TryGetValue(key, out var group))
            {
                group = new LineGroup(line.DeliveryNumber, line.CommodityCode, line.CountryOfOrigin, line.Incoterms);
                groups[key] = group;
                groupOrder.Add(key);
            }
            if (line.InvoiceNumber.Length > 0) group.InvoiceNumbers.Add(line.InvoiceNumber);
            group.StatisticalValue += line.StatisticalValue;
            group.GrossMass += line.GrossMass;
            group.NetMass += line.NetMass;
            group.PackageCount += line.PackageCount;
        }

        var items = groupOrder.Select((key, index) =>
        {
            var group = groups[key];
            var previousDocuments = group.InvoiceNumbers.Select(inv => new PreviousDocument("Z", "380", inv)).ToList();

            return new ClearPortExportItem(
                CorrelationId: $"{shipmentRef}-{(index + 1):D3}",
                ReferenceNumber: group.DeliveryNumber,
                CommodityCode: group.CommodityCode,
                Procedure: clearPort.DefaultProcedure,
                AdditionalProcedures: clearPort.DefaultAdditionalProcedure,
                CountryOfDestination: destinationCountry,
                CountryOfOrigin: group.CountryOfOrigin,
                NetMass: group.NetMass,
                GrossMass: group.GrossMass,
                DescriptionOfGoods: "PTFE Hose",
                Packages: [new ClearPortPackage(clearPort.DefaultPackageType, Math.Max(1, (int)Math.Round(group.PackageCount, MidpointRounding.AwayFromZero)), "As Addressed")],
                NatureOfTransaction: clearPort.DefaultNatureOfTransaction,
                StatisticalValue: Math.Round(group.StatisticalValue, MidpointRounding.AwayFromZero),
                StatisticalValueCurrencyCode: clearPort.DefaultCurrency,
                PreviousDocuments: previousDocuments,
                AdditionalInformation: []);
        }).ToList();

        var allDdp = items.Count > 0 && enrichedLines.All(l => l.Incoterms == "DDP");
        var ddpConsignee = BuildDdpConsignee(clearPort);
        var headerConsignee = allDdp && ddpConsignee is not null ? ddpConsignee : destinationConsignee;
        var totalInvoice = Math.Round(enrichedLines.Sum(l => l.StatisticalValue), MidpointRounding.AwayFromZero);

        return new ClearPortExportRequest(
            Sandbox: clearPort.Sandbox,
            CorrelationId: $"{shipmentRef}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}",
            ExternalSystemLink: $"/private/logistics.html?shipment={Uri.EscapeDataString(shipment.ShipmentId.ToString())}",
            Category: "B1",
            DeclarationType: "EXA",
            ReferenceNumber: shipmentRef,
            Lrn: shipmentRef,
            Ducr: $"{DateTime.UtcNow.Year.ToString()[^1..]}{clearPort.Eori}-{shipmentRef}",
            Exporter: exporter,
            ExporterIdentificationNumber: clearPort.Eori,
            Consignee: headerConsignee,
            Declarant: declarant,
            DeclarantIdentificationNumber: clearPort.Eori,
            RepresentativeStatusCode: 2,
            TransportChargesMethodOfPayment: "",
            TotalInvoice: totalInvoice,
            TotalInvoiceCurrencyCode: clearPort.DefaultCurrency,
            CountryOfDestination: destinationCountry,
            CountryOfDispatch: originCountry,
            LocationOfGoods: clearPort.LocationOfGoods,
            CustomsOfficeOfExit: clearPort.CustomsOfficeOfExit,
            TotalGrossMass: shipment.GrossWeight ?? 0,
            TotalNetMass: shipment.NetWeight ?? 0,
            TotalPackages: Math.Max(1, (int)Math.Round(shipment.PalletCount ?? 0, MidpointRounding.AwayFromZero)),
            Containerised: false,
            NatureOfTransaction: clearPort.DefaultNatureOfTransaction,
            Rrs01: true,
            Rrs01Description: clearPort.Rrs01Description,
            ModeOfTransportAtBorder: clearPort.ModeOfTransportAtBorder,
            InlandModeOfTransport: clearPort.InlandModeOfTransport,
            TypeOfTransportAtDeparture: clearPort.TypeOfTransportAtDeparture,
            IdentityOfTransportAtDeparture: clearPort.IdentityOfTransportAtDeparture,
            TypeOfActiveMeansOfTransportAtBorder: clearPort.TypeOfActiveMeansOfTransportAtBorder,
            IdentityOfActiveMeansOfTransportAtBorder: clearPort.IdentityOfActiveMeansOfTransportAtBorder,
            NationalityOfActiveMeansOfTransportAtBorder: clearPort.NationalityOfActiveMeansOfTransportAtBorder,
            HoldersOfAuthorisation: [new HolderOfAuthorisation("EXRR", clearPort.Eori)],
            Items: items);
    }

    private sealed record EnrichedLine(string DeliveryNumber, string InvoiceNumber, string CommodityCode, string CountryOfOrigin, string Incoterms, decimal StatisticalValue, decimal GrossMass, decimal NetMass, decimal PackageCount);

    private sealed class LineGroup(string deliveryNumber, string commodityCode, string countryOfOrigin, string incoterms)
    {
        public string DeliveryNumber { get; } = deliveryNumber;
        public string CommodityCode { get; } = commodityCode;
        public string CountryOfOrigin { get; } = countryOfOrigin;
        public string Incoterms { get; } = incoterms;
        public HashSet<string> InvoiceNumbers { get; } = [];
        public decimal StatisticalValue { get; set; }
        public decimal GrossMass { get; set; }
        public decimal NetMass { get; set; }
        public decimal PackageCount { get; set; }
    }

    private static NameAndAddress? BuildDdpConsignee(ClearPortOptions clearPort)
    {
        var hasDdpConfig = !string.IsNullOrWhiteSpace(clearPort.DdpConsigneeName) || !string.IsNullOrWhiteSpace(clearPort.DdpConsigneeStreetAndNumber);
        return hasDdpConfig
            ? new NameAndAddress(
                NullIfBlank(clearPort.DdpConsigneeName), NullIfBlank(clearPort.DdpConsigneeStreetAndNumber),
                NullIfBlank(clearPort.DdpConsigneeCityName), NullIfBlank(clearPort.DdpConsigneePostcode),
                NormalizeCountryCode(clearPort.DdpConsigneeCountryCode, "GB"))
            : null;
    }

    private static Dictionary<TKey, TValue> LastWinsMap<TKey, TValue>(IEnumerable<TValue> items, Func<TValue, TKey> keySelector) where TKey : notnull
    {
        var map = new Dictionary<TKey, TValue>();
        foreach (var item in items) map[keySelector(item)] = item;
        return map;
    }

    private static string? NullIfBlank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    internal static NameAndAddress ToNameAndAddress(string? name, string? street, string? city, string? postcode, string? countryCode) =>
        new(NullIfBlank(name), NullIfBlank(street), NullIfBlank(city), NullIfBlank(postcode), NormalizeCountryCode(countryCode, "GB"));

    private static readonly Dictionary<string, string> CountryNameMap = new(StringComparer.OrdinalIgnoreCase)
    {
        ["UNITED KINGDOM"] = "GB", ["GREAT BRITAIN"] = "GB", ["ENGLAND"] = "GB", ["UK"] = "GB",
        ["GERMANY"] = "DE", ["FRANCE"] = "FR", ["BELGIUM"] = "BE", ["NETHERLANDS"] = "NL", ["HOLLAND"] = "NL",
        ["SPAIN"] = "ES", ["ITALY"] = "IT", ["POLAND"] = "PL", ["CZECHIA"] = "CZ", ["CZECH REPUBLIC"] = "CZ",
        ["SLOVAKIA"] = "SK", ["SWEDEN"] = "SE", ["NORWAY"] = "NO", ["IRELAND"] = "IE",
        ["UNITED STATES"] = "US", ["USA"] = "US", ["INDIAL"] = "IN", ["CHINA"] = "CN",
    };

    internal static string NormalizeCountryCode(string? value, string fallback = "GB")
    {
        var raw = (value ?? "").Trim();
        if (raw.Length == 0) return fallback;
        var upper = raw.ToUpperInvariant();
        if (upper.Length == 2 && upper.All(char.IsAsciiLetterUpper)) return upper;
        return CountryNameMap.GetValueOrDefault(upper, fallback);
    }

    /// <summary>
    /// SAP returns numbers in European locale format, e.g. "16.676,20"
    /// (. = thousands, , = decimal) — port of parseEuropeanDecimal, applied
    /// to VbfaRow.StatisticalValue (raw SAP text, unparsed by SapServer's
    /// CustomsHelpers.ParseVbfaRows). SapServer's OWN equivalent naive
    /// always-European-format assumption (the old RfcRowHelpers.GetDecimal)
    /// was confirmed wrong against a live SAP system for other fields —
    /// some values come back as plain invariant-culture text with no
    /// grouping at all, which this exact stripping logic would misparse by
    /// 10x/100x/1000x (see SapServer/CLAUDE.md's GetDecimal bug writeup).
    /// This is Node's OWN separate copy of the same naive assumption
    /// (shipmentmain.js's own local function, not SapServer's fixed
    /// RfcRowExtensions.ParseSapDecimal), preserved exactly since `/customs
    /// /create` has never run against live SAP to confirm whether
    /// StatisticalValue actually needs the same per-value separator
    /// detection fix — flagged here as the first thing to check if a real
    /// ClearPort submission's statisticalValue looks 10x/100x too large.
    /// </summary>
    internal static decimal ParseEuropeanDecimal(string? value)
    {
        var str = (value ?? "").Trim();
        var normalized = str.Replace(".", "").Replace(',', '.');
        return decimal.TryParse(normalized, System.Globalization.NumberStyles.Number, System.Globalization.CultureInfo.InvariantCulture, out var result) ? result : 0m;
    }
}
