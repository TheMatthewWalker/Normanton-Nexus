using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models.Dto;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class PurchaseOrderCreationHelperTests
{
    private static OrderSuggestionTrackedRow Row(
        long suggestionId, string material, decimal orderQty, string? uom = "KG", string? orderMoqUom = null, string? incoterms = null,
        string? poItemNumber = null, DateTime? deliveryDate = null, DateTime? readyToCollectDate = null) =>
        new(suggestionId, VendorId: 1, VendorName: "Acme Ltd", SapVendorNumber: "0000123456", Currency: "GBP", OrderMoqUom: orderMoqUom, Incoterms: incoterms,
            VendorMaterialId: 1, Material: material, MaterialText: $"{material} text", Uom: uom, Status: "Accepted", SuggestedQty: null, OrderQty: orderQty,
            OrderDate: new DateTime(2026, 1, 1), LeadTimeDaysUsed: null, DeliveryDate: deliveryDate, TransitTimeDaysUsed: null, ReadyToCollectDate: readyToCollectDate,
            IsSpotPo: false, PoNumber: null, PoItemNumber: poItemNumber, Notes: null, SupplierReference: null,
            CreatedAtUtc: DateTime.UtcNow, UpdatedAtUtc: DateTime.UtcNow, ReceivedAtUtc: null,
            ShipmentId: null, ShipmentReference: null, Haulier: null, ModeOfTransport: null,
            ShipmentTrackingNumber: null, ExpectedEta: null, ShipmentReceivedAtUtc: null,
            ScheduleAgreement: null, ScheduleAgreementItem: null);

    [Fact]
    public void BuildPoPdfItems_assigns_x10_PO_item_numbers_by_row_position_when_none_stored_yet()
    {
        var rows = new[] { Row(1, "M1", 100m), Row(2, "M2", 50m) };

        var items = PurchaseOrderCreationHelper.BuildPoPdfItems(rows);

        Assert.Equal("00010", items[0].PoItemNumber);
        Assert.Equal("00020", items[1].PoItemNumber);
    }

    [Fact]
    public void BuildPoPdfItems_uses_the_rows_own_PoItemNumber_when_already_stored()
    {
        var rows = new[] { Row(1, "M1", 100m, poItemNumber: "00030") };

        var items = PurchaseOrderCreationHelper.BuildPoPdfItems(rows);

        Assert.Equal("00030", items[0].PoItemNumber);
    }

    [Fact]
    public void BuildPoPdfItems_converts_quantity_into_the_vendors_order_unit()
    {
        var rows = new[] { Row(1, "M1", orderQty: 45.359237m, uom: "KG", orderMoqUom: "LB") };

        var items = PurchaseOrderCreationHelper.BuildPoPdfItems(rows);

        Assert.Equal("LB", items[0].Uom);
        Assert.Equal(100m, Math.Round(items[0].Quantity, 3));
    }

    [Fact]
    public void BuildPoPdfItems_prefers_a_manual_price_override_over_the_SAP_queried_price()
    {
        var rows = new[] { Row(1, "M1", 10m, poItemNumber: "00010") };
        var overrides = new Dictionary<long, decimal> { [1] = 5.5m };
        var prices = new Dictionary<string, decimal> { ["10"] = 9.99m };

        var items = PurchaseOrderCreationHelper.BuildPoPdfItems(rows, overrides, prices);

        Assert.Equal(5.5m, items[0].NetPrice);
    }

    [Fact]
    public void BuildPoPdfItems_falls_back_to_the_SAP_queried_price_normalised_to_a_bare_integer_key()
    {
        var rows = new[] { Row(1, "M1", 10m, poItemNumber: "00010") };
        var prices = new Dictionary<string, decimal> { ["10"] = 9.99m };

        var items = PurchaseOrderCreationHelper.BuildPoPdfItems(rows, null, prices);

        Assert.Equal(9.99m, items[0].NetPrice);
    }

    [Fact]
    public void BuildPoPdfItems_leaves_NetPrice_null_when_no_override_or_SAP_price_is_available()
    {
        var rows = new[] { Row(1, "M1", 10m, poItemNumber: "00010") };

        var items = PurchaseOrderCreationHelper.BuildPoPdfItems(rows);

        Assert.Null(items[0].NetPrice);
    }

    [Fact]
    public void BuildPoPdfItems_uses_ReadyToCollectDate_instead_of_DeliveryDate_for_an_EXW_line()
    {
        var deliveryDate = new DateTime(2026, 5, 1);
        var readyDate = new DateTime(2026, 4, 20);
        var rows = new[] { Row(1, "M1", 10m, incoterms: "EXW", deliveryDate: deliveryDate, readyToCollectDate: readyDate) };

        var items = PurchaseOrderCreationHelper.BuildPoPdfItems(rows);

        Assert.True(items[0].IsExw);
        Assert.Equal(readyDate, items[0].DeliveryDate);
    }

    [Fact]
    public void BuildPoPdfItems_uses_DeliveryDate_for_a_non_EXW_line()
    {
        var deliveryDate = new DateTime(2026, 5, 1);
        var rows = new[] { Row(1, "M1", 10m, incoterms: "DAP", deliveryDate: deliveryDate) };

        var items = PurchaseOrderCreationHelper.BuildPoPdfItems(rows);

        Assert.False(items[0].IsExw);
        Assert.Equal(deliveryDate, items[0].DeliveryDate);
    }

    // ── PurchaseOrderPdfHelper.BuildPoPdf (structural — real PDF bytes, no viewer in this sandbox) ──

    [Fact]
    public void BuildPoPdf_produces_a_valid_PDF_with_priced_line_items()
    {
        var data = new PoPdfData("4500012345", new DateTime(2026, 6, 1), "Acme Ltd", "0000123456", "GBP", "DAP", "Jane Smith",
            [new PoPdfItem("00010", "MAT1", "Widget", 100m, "KG", new DateTime(2026, 6, 15), false, 12.50m)]);

        var bytes = PurchaseOrderPdfHelper.BuildPoPdf(data);

        Assert.True(bytes.Length > 500);
        Assert.Equal("%PDF"u8.ToArray(), bytes[..4]);
    }

    [Fact]
    public void BuildPoPdf_produces_a_valid_PDF_with_no_price_on_any_line()
    {
        var data = new PoPdfData("4500012345", new DateTime(2026, 6, 1), "Acme Ltd", "0000123456", "GBP", null, null,
            [new PoPdfItem("00010", "MAT1", "Widget", 100m, "KG", new DateTime(2026, 6, 15), false, null)]);

        var bytes = PurchaseOrderPdfHelper.BuildPoPdf(data);

        Assert.True(bytes.Length > 500);
        Assert.Equal("%PDF"u8.ToArray(), bytes[..4]);
    }

    [Fact]
    public void BuildPoPdf_produces_a_valid_PDF_with_no_items_at_all()
    {
        var data = new PoPdfData("4500012345", DateTime.UtcNow, "Acme Ltd", null, null, null, null, []);

        var bytes = PurchaseOrderPdfHelper.BuildPoPdf(data);

        Assert.True(bytes.Length > 500);
        Assert.Equal("%PDF"u8.ToArray(), bytes[..4]);
    }
}
