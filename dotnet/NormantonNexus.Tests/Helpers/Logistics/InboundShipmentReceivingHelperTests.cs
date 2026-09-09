using Moq;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;

namespace NormantonNexus.Tests.Helpers.Logistics;

/// <summary>Sub-phase 8b.7 — Mark Received/Undo Received's PostGoodsReceiptToSapAsync pre-SAP-call guards (no PO on file / no PO item number / a confirmed-zero received quantity all skip the SAP call entirely, matching Node's postGoodsReceiptToSap exactly).</summary>
public class InboundShipmentReceivingHelperTests
{
    private static Mock<ISapServerClient> UnreachableSap()
    {
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<BdcResponse>(It.IsAny<string>(), It.IsAny<object>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return sap;
    }

    private static InboundShipmentHelper.ReceivableOrderRow Order(string? poNumber = "4500012345", string? poItemNumber = "00010") =>
        new(SuggestionId: 1, Material: "M1", OrderQty: 100m, PoNumber: poNumber, PoItemNumber: poItemNumber, SupplierReference: "REF1", OrderMoqUom: "KG", MaterialUom: "KG");

    [Fact]
    public async Task PostGoodsReceiptToSapAsync_skips_when_no_PO_number_on_file()
    {
        var sap = UnreachableSap();

        var result = await InboundShipmentHelper.PostGoodsReceiptToSapAsync(sap.Object, Order(poNumber: null), 50m, "SHIP-1", "TRK1", DateTime.UtcNow, 1, CancellationToken.None);

        Assert.True(result.Skipped);
        Assert.True(result.Success);
        Assert.Contains("No SAP PO number", result.Error);
    }

    [Fact]
    public async Task PostGoodsReceiptToSapAsync_skips_when_PO_item_number_is_missing()
    {
        var sap = UnreachableSap();

        var result = await InboundShipmentHelper.PostGoodsReceiptToSapAsync(sap.Object, Order(poItemNumber: null), 50m, "SHIP-1", "TRK1", DateTime.UtcNow, 1, CancellationToken.None);

        Assert.True(result.Skipped);
        Assert.Contains("PO item number is missing", result.Error);
    }

    [Fact]
    public async Task PostGoodsReceiptToSapAsync_skips_a_confirmed_zero_quantity()
    {
        var sap = UnreachableSap();

        var result = await InboundShipmentHelper.PostGoodsReceiptToSapAsync(sap.Object, Order(), 0m, "SHIP-1", "TRK1", DateTime.UtcNow, 1, CancellationToken.None);

        Assert.True(result.Skipped);
        Assert.Contains("nothing to post", result.Error);
    }

    [Fact]
    public async Task PostGoodsReceiptToSapAsync_calls_SAP_when_a_real_PO_and_a_positive_quantity_are_present()
    {
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<BdcResponse>("api/purchasing/post-goods-receipt", It.IsAny<object>(), 1, false, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new BdcResponse("S", "", "", "", "5000001234", ""));

        var result = await InboundShipmentHelper.PostGoodsReceiptToSapAsync(sap.Object, Order(), 50m, "SHIP-1", "TRK1", DateTime.UtcNow, 1, CancellationToken.None);

        Assert.False(result.Skipped);
        Assert.True(result.Success);
        Assert.Equal("5000001234", result.DocumentNumber);
    }

    [Fact]
    public async Task PostGoodsReceiptToSapAsync_treats_a_BDC_type_E_response_as_a_failure()
    {
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<BdcResponse>(It.IsAny<string>(), It.IsAny<object>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new BdcResponse("E", "", "", "Movement type blocked", "", ""));

        var result = await InboundShipmentHelper.PostGoodsReceiptToSapAsync(sap.Object, Order(), 50m, "SHIP-1", "TRK1", DateTime.UtcNow, 1, CancellationToken.None);

        Assert.False(result.Success);
        Assert.False(result.Skipped);
        Assert.Equal("Movement type blocked", result.Error);
    }
}
