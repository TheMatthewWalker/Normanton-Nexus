using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class FreightBookingHelperTests
{
    // ── MapPalletsToCargoItems ─────────────────────────────────────────

    private static ShipmentContextPalletRow Pallet(long id, string? type = "Standard", decimal grossWeight = 100m, decimal volume = 1.2m, int? length = 120, int? width = 100, int? height = 150) =>
        new(DeliveryId: 1, PalletId: id, PalletType: type, PalletFinish: false, PackagingWeight: 10m, GrossWeight: grossWeight, PalletVolume: volume,
            PalletLength: length, PalletWidth: width, PalletHeight: height, PalletLocation: "A1");

    [Fact]
    public void MapPalletsToCargoItems_maps_every_field_and_converts_cm_dimensions_to_mm()
    {
        var items = FreightBookingHelper.MapPalletsToCargoItems([Pallet(12345)]);

        var item = Assert.Single(items);
        Assert.Equal("Standard", item.Description);
        Assert.Equal("12345", item.MarksAndNumbers);
        Assert.False(item.Stackable);
        Assert.Equal(1, item.PackageCount);
        Assert.Equal("PLT", item.PackageType);
        Assert.Equal(100m, item.Weight);
        Assert.Equal("KGM", item.WeightUom);
        Assert.Equal(1.2m, item.Volume);
        Assert.Equal("MTQ", item.VolumeUom);
        Assert.Equal(1200m, item.DimensionLength);
        Assert.Equal(1000m, item.DimensionWidth);
        Assert.Equal(1500m, item.DimensionHeight);
        Assert.Equal("MMT", item.DimensionsUom);
    }

    [Fact]
    public void MapPalletsToCargoItems_falls_back_to_Pallet_when_palletType_is_blank()
    {
        var items = FreightBookingHelper.MapPalletsToCargoItems([Pallet(1, type: null)]);

        Assert.Equal("Pallet", items[0].Description);
    }

    [Fact]
    public void MapPalletsToCargoItems_treats_a_missing_dimension_as_zero()
    {
        var items = FreightBookingHelper.MapPalletsToCargoItems([Pallet(1, length: null, width: null, height: null)]);

        Assert.Equal(0m, items[0].DimensionLength);
        Assert.Equal(0m, items[0].DimensionWidth);
        Assert.Equal(0m, items[0].DimensionHeight);
    }

    // ── MapManualCargoToCargoItems ─────────────────────────────────────

    private static ManualCargoItemRow ManualCargo(int id, string? description = "Custom crate", int packageCount = 2, decimal weight = 50m) =>
        new(CargoId: id, ShipmentId: 1, Description: description, PackageCount: packageCount, Weight: weight,
            Length: 80m, Width: 60m, Height: 40m, Volume: 0.19m, CreatedAtUtc: DateTime.UtcNow, CreatedBy: "tester");

    [Fact]
    public void MapManualCargoToCargoItems_maps_every_field_and_converts_cm_dimensions_to_mm()
    {
        var items = FreightBookingHelper.MapManualCargoToCargoItems([ManualCargo(99)]);

        var item = Assert.Single(items);
        Assert.Equal("Custom crate", item.Description);
        Assert.Equal("99", item.MarksAndNumbers);
        Assert.Equal(2, item.PackageCount);
        Assert.Equal("PKG", item.PackageType);
        Assert.Equal(50m, item.Weight);
        Assert.Equal(0.19m, item.Volume);
        Assert.Equal(800m, item.DimensionLength);
        Assert.Equal(600m, item.DimensionWidth);
        Assert.Equal(400m, item.DimensionHeight);
    }

    [Fact]
    public void MapManualCargoToCargoItems_falls_back_to_Cargo_when_description_is_blank()
    {
        var items = FreightBookingHelper.MapManualCargoToCargoItems([ManualCargo(1, description: "")]);

        Assert.Equal("Cargo", items[0].Description);
    }

    [Fact]
    public void MapManualCargoToCargoItems_defaults_a_non_positive_packageCount_to_1()
    {
        var items = FreightBookingHelper.MapManualCargoToCargoItems([ManualCargo(1, packageCount: 0)]);

        Assert.Equal(1, items[0].PackageCount);
    }

    // ── BuildBookingPayload ────────────────────────────────────────────

    private static ShipmentRow Shipment(DateTime? plannedCollection = null, string? incoTerms = "DAP") => new(
        ShipmentId: 555, OriginId: 1, OriginName: "Kongsberg UK", OriginStreet: "1 Factory Road", OriginCity: "Redditch", OriginPostCode: "B98 1AA", OriginCountry: "GB",
        DestinationId: 2, DestinationName: "Acme SARL", DestinationStreet: "10 Rue Example", DestinationCity: "Paris", DestinationPostCode: "75001", DestinationCountry: "FR",
        NetWeight: 100m, GrossWeight: 110m, PalletCount: 1m, ShipmentVolume: 1m,
        PlannedCollection: plannedCollection, ActualCollection: null, CollectionStatus: false,
        ForwarderId: null, TrackingNumber: null, IncoTerms: incoTerms, CustomsRequired: true, CustomsComplete: false, ShipmentCancelled: false,
        PlannedDelivery: null, ActualDelivery: null, DeliveryStatus: false, BookingStatus: false, CustomsId: null, IsManual: false,
        ForwarderName: null, ForwarderMode: null, PlannedMovement: null);

    private static KuehneNagelOptions Options() => new() { ApiUrl = "https://kn.example.com", CustomerId = "CUST1", CustomerKey = "SECRETKEY123" };

    [Fact]
    public void BuildBookingPayload_maps_origin_and_destination_addresses()
    {
        var payload = FreightBookingHelper.BuildBookingPayload(Shipment(), [], Options(), null);

        Assert.Equal("Kongsberg UK", payload.ShipperParty.Address.Name1);
        Assert.Equal("GB", payload.ShipperParty.Address.CountryCode);
        Assert.Equal("Acme SARL", payload.ConsigneeParty.Address.Name1);
        Assert.Equal("FR", payload.ConsigneeParty.Address.CountryCode);
        Assert.Equal("Kongsberg UK", payload.PickupLocation.Address.Name1);
        Assert.Equal("Acme SARL", payload.DeliveryLocation.Address.Name1);
    }

    [Fact]
    public void BuildBookingPayload_uses_the_shipments_own_ID_as_the_shipper_ABO_reference()
    {
        var payload = FreightBookingHelper.BuildBookingPayload(Shipment(), [], Options(), null);

        var reference = Assert.Single(payload.ShipperParty.References);
        Assert.Equal("555", reference.Value);
        Assert.Equal("ABO", reference.Code);
    }

    [Fact]
    public void BuildBookingPayload_uses_the_shipments_own_PlannedCollection_when_no_override_given()
    {
        var payload = FreightBookingHelper.BuildBookingPayload(Shipment(plannedCollection: new DateTime(2026, 6, 15)), [], Options(), null);

        Assert.Equal("2026-06-15", payload.PickupLocation.RequestDate);
    }

    [Fact]
    public void BuildBookingPayload_prefers_an_explicit_plannedCollection_override_over_the_shipments_own()
    {
        var payload = FreightBookingHelper.BuildBookingPayload(Shipment(plannedCollection: new DateTime(2026, 6, 15)), [], Options(), new DateTime(2026, 7, 1));

        Assert.Equal("2026-07-01", payload.PickupLocation.RequestDate);
    }

    [Fact]
    public void BuildBookingPayload_leaves_requestDate_null_when_neither_is_set()
    {
        var payload = FreightBookingHelper.BuildBookingPayload(Shipment(plannedCollection: null), [], Options(), null);

        Assert.Null(payload.PickupLocation.RequestDate);
    }

    [Fact]
    public void BuildBookingPayload_carries_customerId_customerKey_and_incoterms_from_config_and_shipment()
    {
        var payload = FreightBookingHelper.BuildBookingPayload(Shipment(incoTerms: "EXW"), [], Options(), null);

        Assert.Equal("CUST1", payload.CustomerId);
        Assert.Equal("SECRETKEY123", payload.CustomerKey);
        Assert.Equal("EXW", payload.Incoterm.Code);
    }

    [Fact]
    public void BuildBookingPayload_sets_every_booking_flag_false()
    {
        var payload = FreightBookingHelper.BuildBookingPayload(Shipment(), [], Options(), null);

        Assert.False(payload.BookingFlags.AppointmentRequired);
        Assert.False(payload.BookingFlags.TailLiftRequired);
        Assert.False(payload.BookingFlags.HighValue);
        Assert.False(payload.BookingFlags.OversizedGoods);
        Assert.False(payload.BookingFlags.PrivateConsignee);
        Assert.False(payload.BookingFlags.InsuranceFlag);
    }

    // ── MaskCustomerKey / RedactBookingPayload ──────────────────────────

    [Theory]
    [InlineData("SECRETKEY123", "SECR...Y123")]
    [InlineData("short", "short")] // 8 chars or fewer — left unmasked, matching Node's own `.length > 8` check
    [InlineData("", "")]
    [InlineData(null, "")]
    public void MaskCustomerKey_masks_a_key_longer_than_8_chars_only(string? key, string expected)
    {
        Assert.Equal(expected, FreightBookingHelper.MaskCustomerKey(key));
    }

    [Fact]
    public void RedactBookingPayload_masks_only_the_customerKey_field()
    {
        var payload = FreightBookingHelper.BuildBookingPayload(Shipment(), [], Options(), null);

        var redacted = FreightBookingHelper.RedactBookingPayload(payload);

        Assert.Equal("SECR...Y123", redacted.CustomerKey);
        Assert.Equal(payload.CustomerId, redacted.CustomerId);
        Assert.Equal(payload.ShipperParty, redacted.ShipperParty);
    }

    // ── ExtractTrackingNumber ────────────────────────────────────────

    [Fact]
    public void ExtractTrackingNumber_returns_empty_string_for_null_data()
    {
        Assert.Equal("", FreightBookingHelper.ExtractTrackingNumber(null));
    }

    [Fact]
    public void ExtractTrackingNumber_prefers_trackingNumber_over_every_other_key()
    {
        var data = new Dictionary<string, object?> { ["trackingNumber"] = "TRACK1", ["bookingID"] = "BOOK1" };

        Assert.Equal("TRACK1", FreightBookingHelper.ExtractTrackingNumber(data));
    }

    [Fact]
    public void ExtractTrackingNumber_falls_back_to_bookingID_when_nothing_earlier_in_the_list_is_present()
    {
        var data = new Dictionary<string, object?> { ["bookingID"] = "BOOK1", ["transactionID"] = "TXN1" };

        Assert.Equal("BOOK1", FreightBookingHelper.ExtractTrackingNumber(data));
    }

    [Fact]
    public void ExtractTrackingNumber_skips_a_blank_value_and_uses_the_next_key()
    {
        var data = new Dictionary<string, object?> { ["trackingNumber"] = "", ["trackingNo"] = "TRACKNO1" };

        Assert.Equal("TRACKNO1", FreightBookingHelper.ExtractTrackingNumber(data));
    }
}
