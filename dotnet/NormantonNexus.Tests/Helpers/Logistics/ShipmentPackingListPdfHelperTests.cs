using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models.Dto;

namespace NormantonNexus.Tests.Helpers.Logistics;

// Same precedent as LabelPdfHelperTests: QuestPDF's Document.GeneratePdf()
// runs for real here, generating actual PDF bytes checked for real,
// verifiable structure (the %PDF magic header, byte length) rather than
// just "didn't throw" — no PDF viewer in this sandbox to check pixel
// fidelity against Node's own hand-rolled PDF output.
public class ShipmentPackingListPdfHelperTests
{
    private static ShipmentRow SampleShipment(bool isManual = false) => new(
        ShipmentId: 42, OriginId: null, OriginName: "Kongsberg Actuation System Ltd", OriginStreet: null, OriginCity: null, OriginPostCode: null, OriginCountry: null,
        DestinationId: 100, DestinationName: "Acme Ltd", DestinationStreet: "1 Main St", DestinationCity: "Leeds", DestinationPostCode: "LS1 1AA", DestinationCountry: "GB",
        NetWeight: 500m, GrossWeight: 550m, PalletCount: 2m, ShipmentVolume: 3.5m,
        PlannedCollection: new DateTime(2026, 3, 1), ActualCollection: null, CollectionStatus: false,
        ForwarderId: 5, TrackingNumber: "TRK123", IncoTerms: "DAP", CustomsRequired: false, CustomsComplete: false, ShipmentCancelled: false,
        PlannedDelivery: new DateTime(2026, 3, 3), ActualDelivery: null, DeliveryStatus: false, BookingStatus: true, CustomsId: null, IsManual: isManual,
        ForwarderName: "Best Haulage", ForwarderMode: "Road", PlannedMovement: null);

    private static ShipmentContextPalletRow SamplePallet(long deliveryId, long palletId) => new(
        deliveryId, palletId, "EU", false, 15m, 280m, 1.2m, 120, 80, 100, "A1");

    private static ManualCargoItemRow SampleManualCargo(int cargoId) => new(
        cargoId, 42, "Spare parts", 3, 45.5m, 60, 40, 30, 0.072m, DateTime.Now, "jsmith");

    [Fact]
    public void BuildPackingListPdf_produces_a_valid_PDF_for_a_normal_shipment_with_pallets()
    {
        var context = new ShipmentContext(
            SampleShipment(), [new ShipmentContextDeliveryRow(200, 100, null, null, null, null, 500, 550, 2, 3.5m, "Acme Ltd", "1 Main St", "Leeds", "LS1 1AA", "GB", null)],
            [SamplePallet(200, 1), SamplePallet(200, 2)], []);

        var bytes = ShipmentPackingListPdfHelper.BuildPackingListPdf(context);

        Assert.True(bytes.Length > 500);
        Assert.Equal("%PDF"u8.ToArray(), bytes[..4]);
    }

    [Fact]
    public void BuildPackingListPdf_produces_a_valid_PDF_for_a_manual_shipment_with_cargo_lines()
    {
        var context = new ShipmentContext(SampleShipment(isManual: true), [], [], [SampleManualCargo(1), SampleManualCargo(2)]);

        var bytes = ShipmentPackingListPdfHelper.BuildPackingListPdf(context);

        Assert.True(bytes.Length > 500);
        Assert.Equal("%PDF"u8.ToArray(), bytes[..4]);
    }

    [Fact]
    public void BuildPackingListPdf_does_not_throw_for_a_shipment_with_no_pallets_or_cargo()
    {
        var context = new ShipmentContext(SampleShipment(), [], [], []);

        var bytes = ShipmentPackingListPdfHelper.BuildPackingListPdf(context);

        Assert.True(bytes.Length > 200);
    }

    [Fact]
    public void BuildLoadingListPdf_produces_a_valid_PDF_for_multiple_shipments()
    {
        var shipmentsData = new[]
        {
            (SampleShipment(), (IReadOnlyList<ShipmentContextPalletRow>)[SamplePallet(200, 1)]),
            (SampleShipment() with { ShipmentId = 43 }, (IReadOnlyList<ShipmentContextPalletRow>)[]),
        };

        var bytes = ShipmentPackingListPdfHelper.BuildLoadingListPdf(shipmentsData);

        Assert.True(bytes.Length > 500);
        Assert.Equal("%PDF"u8.ToArray(), bytes[..4]);
    }
}
