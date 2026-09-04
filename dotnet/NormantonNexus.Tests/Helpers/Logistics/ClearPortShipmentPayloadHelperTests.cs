using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class ClearPortShipmentPayloadHelperTests
{
    private static ShipmentRow SampleShipment() => new(
        ShipmentId: 42, OriginId: 0, OriginName: "Kongsberg Actuation System Ltd", OriginStreet: "Euroflex Centre", OriginCity: "Normanton", OriginPostCode: "WF6 1TN", OriginCountry: "GB",
        DestinationId: 100, DestinationName: "Acme Ltd", DestinationStreet: "1 Main St", DestinationCity: "Berlin", DestinationPostCode: "10115", DestinationCountry: "DE",
        NetWeight: 500m, GrossWeight: 550m, PalletCount: 2m, ShipmentVolume: 3.5m,
        PlannedCollection: new DateTime(2026, 3, 1), ActualCollection: null, CollectionStatus: false,
        ForwarderId: 5, TrackingNumber: "TRK123", IncoTerms: "DAP", CustomsRequired: true, CustomsComplete: false, ShipmentCancelled: false,
        PlannedDelivery: new DateTime(2026, 3, 3), ActualDelivery: null, DeliveryStatus: false, BookingStatus: true, CustomsId: null, IsManual: false,
        ForwarderName: "Best Haulage", ForwarderMode: "Road", PlannedMovement: null);

    private static ShipmentContextDeliveryRow SampleDelivery(long deliveryId) => new(
        deliveryId, 100, null, null, null, null, 500, 550, 2, 3.5m, "Acme Ltd", "1 Main St", "Berlin", "10115", "DE", null);

    private static (ClearPortOptions ClearPort, LogisticsOptions Logistics) DefaultOptions() => (new ClearPortOptions(), new LogisticsOptions());

    [Fact]
    public void Build_throws_when_the_shipment_has_no_linked_deliveries()
    {
        var context = new ShipmentContext(SampleShipment(), [], [], []);
        var sapData = new SapCustomsData([], [], [], [], []);
        var (clearPort, logistics) = DefaultOptions();

        var ex = Assert.Throws<NexusValidationException>(() => ClearPortShipmentPayloadHelper.Build(context, sapData, clearPort, logistics));
        Assert.Contains("no linked deliveries", ex.Message);
    }

    [Fact]
    public void Build_throws_when_SAP_returned_no_LIPS_lines()
    {
        var context = new ShipmentContext(SampleShipment(), [SampleDelivery(200)], [], []);
        var sapData = new SapCustomsData([], [], [], [], []);
        var (clearPort, logistics) = DefaultOptions();

        var ex = Assert.Throws<NexusUnprocessableEntityException>(() => ClearPortShipmentPayloadHelper.Build(context, sapData, clearPort, logistics));
        Assert.Contains("No SAP line items", ex.Message);
    }

    [Fact]
    public void Build_produces_one_item_per_delivery_commodity_group_with_a_single_LIPS_line()
    {
        var context = new ShipmentContext(SampleShipment(), [SampleDelivery(200)], [], []);
        var sapData = new SapCustomsData(
            LipsData: [new LipsRow("200", "1", "MAT001", "10")],
            LikpData: [new LikpRow("200", "DAP", "CUST1", "20260301")],
            VbfaData: [new VbfaRow("200", "1", "INV001", "1", "1000,00", "20260301")],
            MarcData: [new MarcRow("MAT001", "39173900", "GB")],
            Kna1Data: []);
        var (clearPort, logistics) = DefaultOptions();

        var payload = ClearPortShipmentPayloadHelper.Build(context, sapData, clearPort, logistics);

        Assert.Equal("00000042", payload.ReferenceNumber);
        Assert.Single(payload.Items);
        var item = payload.Items[0];
        Assert.Equal("200", item.ReferenceNumber);
        Assert.Equal("39173900", item.CommodityCode);
        Assert.Equal("GB", item.CountryOfOrigin);
        Assert.Equal(1000m, item.StatisticalValue);
        Assert.Single(item.PreviousDocuments);
        Assert.Equal("INV001", item.PreviousDocuments[0].DocumentReference);
    }

    [Fact]
    public void Build_groups_multiple_LIPS_lines_for_the_same_delivery_and_commodity_into_one_item()
    {
        var context = new ShipmentContext(SampleShipment(), [SampleDelivery(200)], [], []);
        var sapData = new SapCustomsData(
            LipsData: [new LipsRow("200", "1", "MAT001", "10"), new LipsRow("200", "2", "MAT001", "5")],
            LikpData: [new LikpRow("200", "DAP", "CUST1", "20260301")],
            VbfaData: [new VbfaRow("200", "1", "INV001", "1", "500,00", "20260301"), new VbfaRow("200", "2", "INV002", "1", "300,00", "20260301")],
            MarcData: [new MarcRow("MAT001", "39173900", "GB")],
            Kna1Data: []);
        var (clearPort, logistics) = DefaultOptions();

        var payload = ClearPortShipmentPayloadHelper.Build(context, sapData, clearPort, logistics);

        Assert.Single(payload.Items);
        var item = payload.Items[0];
        Assert.Equal(800m, item.StatisticalValue);
        Assert.Equal(2, item.PreviousDocuments.Count);
        // Each LIPS line for the delivery halves the delivery's own gross/net mass (2 lines here).
        Assert.Equal(550m, item.GrossMass);
        Assert.Equal(500m, item.NetMass);
    }

    [Fact]
    public void Build_falls_back_to_the_default_commodity_code_when_MARC_has_no_row_for_the_material()
    {
        var context = new ShipmentContext(SampleShipment(), [SampleDelivery(200)], [], []);
        var sapData = new SapCustomsData(
            LipsData: [new LipsRow("200", "1", "UNKNOWN-MAT", "10")],
            LikpData: [],
            VbfaData: [],
            MarcData: [],
            Kna1Data: []);
        var (clearPort, logistics) = DefaultOptions();

        var payload = ClearPortShipmentPayloadHelper.Build(context, sapData, clearPort, logistics);

        Assert.Equal(clearPort.DefaultCommodityCode, payload.Items[0].CommodityCode);
    }

    [Fact]
    public void Build_uses_the_DDP_consignee_for_the_header_only_when_every_line_is_DDP()
    {
        var shipment = SampleShipment() with { IncoTerms = "DDP" };
        var context = new ShipmentContext(shipment, [SampleDelivery(200)], [], []);
        var sapData = new SapCustomsData(
            LipsData: [new LipsRow("200", "1", "MAT001", "10")],
            LikpData: [new LikpRow("200", "DDP", "CUST1", "20260301")],
            VbfaData: [],
            MarcData: [],
            Kna1Data: []);
        var clearPort = new ClearPortOptions { DdpConsigneeName = "DDP Warehouse Ltd", DdpConsigneeStreetAndNumber = "1 Bonded Way" };
        var logistics = new LogisticsOptions();

        var payload = ClearPortShipmentPayloadHelper.Build(context, sapData, clearPort, logistics);

        Assert.Equal("DDP Warehouse Ltd", payload.Consignee.Name);
    }

    [Fact]
    public void Build_uses_the_destination_consignee_when_DDP_is_configured_but_not_every_line_is_DDP()
    {
        var context = new ShipmentContext(SampleShipment(), [SampleDelivery(200)], [], []);
        var sapData = new SapCustomsData(
            LipsData: [new LipsRow("200", "1", "MAT001", "10")],
            LikpData: [new LikpRow("200", "DAP", "CUST1", "20260301")],
            VbfaData: [],
            MarcData: [],
            Kna1Data: []);
        var clearPort = new ClearPortOptions { DdpConsigneeName = "DDP Warehouse Ltd", DdpConsigneeStreetAndNumber = "1 Bonded Way" };
        var logistics = new LogisticsOptions();

        var payload = ClearPortShipmentPayloadHelper.Build(context, sapData, clearPort, logistics);

        Assert.Equal("Acme Ltd", payload.Consignee.Name);
    }

    [Fact]
    public void Build_rounds_statistical_value_to_the_nearest_whole_number_matching_the_preserved_JS_Math_round_bug()
    {
        var context = new ShipmentContext(SampleShipment(), [SampleDelivery(200)], [], []);
        var sapData = new SapCustomsData(
            LipsData: [new LipsRow("200", "1", "MAT001", "10")],
            LikpData: [],
            VbfaData: [new VbfaRow("200", "1", "INV001", "1", "1000,567", "20260301")],
            MarcData: [],
            Kna1Data: []);
        var (clearPort, logistics) = DefaultOptions();

        var payload = ClearPortShipmentPayloadHelper.Build(context, sapData, clearPort, logistics);

        Assert.Equal(1001m, payload.Items[0].StatisticalValue);
        Assert.Equal(1001m, payload.TotalInvoice);
    }

    [Theory]
    [InlineData("gb", "GB")]
    [InlineData("de", "DE")]
    [InlineData("Germany", "DE")]
    [InlineData("united kingdom", "GB")]
    [InlineData("", "GB")]
    [InlineData("Atlantis", "GB")]
    public void NormalizeCountryCode_maps_names_and_codes_and_falls_back(string input, string expected)
    {
        Assert.Equal(expected, ClearPortShipmentPayloadHelper.NormalizeCountryCode(input, "GB"));
    }

    [Theory]
    [InlineData("16.676,20", 16676.20)]
    [InlineData("1000,00", 1000)]
    [InlineData("50", 50)]
    [InlineData("", 0)]
    [InlineData(null, 0)]
    public void ParseEuropeanDecimal_parses_european_formatted_values(string? input, double expected)
    {
        Assert.Equal((decimal)expected, ClearPortShipmentPayloadHelper.ParseEuropeanDecimal(input));
    }

    [Fact]
    public void ToNameAndAddress_returns_null_for_blank_fields_and_normalizes_the_country()
    {
        var result = ClearPortShipmentPayloadHelper.ToNameAndAddress("  ", "1 Main St", "", null, "germany");

        Assert.Null(result.Name);
        Assert.Equal("1 Main St", result.StreetAndNumber);
        Assert.Null(result.CityName);
        Assert.Null(result.Postcode);
        Assert.Equal("DE", result.CountryCode);
    }
}
