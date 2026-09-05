using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models.Dto;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class StockAllocationHelperTests
{
    [Theory]
    [InlineData("IB_ACME_10L", "ACME")]
    [InlineData("IB_BETA_LTD_5L", "BETA")]
    [InlineData(null, null)]
    [InlineData("", null)]
    [InlineData("SOME_OTHER_MATERIAL", null)]
    public void PackagingCustomer_extracts_the_customer_token_between_IB_and_the_next_underscore(string? packagingMaterial, string? expected)
    {
        Assert.Equal(expected, StockAllocationHelper.PackagingCustomer(packagingMaterial));
    }

    [Theory]
    [InlineData("123", "0000000123")]
    [InlineData("0080012345", "0080012345")]
    [InlineData(null, "0000000000")]
    public void StagingBin_left_pads_the_reference_document_to_10_characters(string? referenceDocument, string expected)
    {
        Assert.Equal(expected, StockAllocationHelper.StagingBin(referenceDocument));
    }

    private static SapAgreementRow Agreement(string material, string customer, string referenceDocument, decimal orderQty, DateTime requestDate) =>
        new() { Material = material, Customer = customer, ReferenceDocument = referenceDocument, OrderQty = orderQty, RequestDate = requestDate };

    private static SapPerformanceStockRow Stock(string material, decimal availableQty, decimal totalQty, string storageBin, string? packagingMaterial = null) =>
        new() { Material = material, AvailableQty = availableQty, TotalQty = totalQty, StorageBin = storageBin, PackagingMaterial = packagingMaterial };

    [Fact]
    public void AllocateStock_allocates_dock_stock_up_to_available_qty()
    {
        var agreements = new[] { Agreement("M1", "C1", "SO1", 100m, new DateTime(2026, 1, 1)) };
        var stock = new[] { Stock("M1", availableQty: 60m, totalQty: 0m, storageBin: "BIN1", packagingMaterial: "IB_C1_TEST") };

        var result = StockAllocationHelper.AllocateStock(agreements, stock);

        Assert.Equal(60m, result[0].DockStockAllocated);
    }

    [Fact]
    public void AllocateStock_allocates_picked_stock_from_the_padded_staging_bin_matching_the_reference_document()
    {
        var agreements = new[] { Agreement("M1", "C1", "80012345", 40m, new DateTime(2026, 1, 1)) };
        var stock = new[] { Stock("M1", availableQty: 0m, totalQty: 40m, storageBin: "0080012345") };

        var result = StockAllocationHelper.AllocateStock(agreements, stock);

        Assert.Equal(40m, result[0].PickedStockAllocated);
    }

    [Fact]
    public void AllocateStock_serves_earlier_requestDate_agreements_first_FIFO()
    {
        var agreements = new[]
        {
            Agreement("M1", "C1", "SO2", 60m, new DateTime(2026, 2, 1)),
            Agreement("M1", "C1", "SO1", 60m, new DateTime(2026, 1, 1)), // earlier, listed second
        };
        var stock = new[] { Stock("M1", availableQty: 60m, totalQty: 0m, storageBin: "BIN1", packagingMaterial: "IB_C1_TEST") };

        var result = StockAllocationHelper.AllocateStock(agreements, stock);

        var so1 = result.Single(r => r.ReferenceDocument == "SO1");
        var so2 = result.Single(r => r.ReferenceDocument == "SO2");
        Assert.Equal(60m, so1.DockStockAllocated); // earlier date gets the full pool
        Assert.Equal(0m, so2.DockStockAllocated);  // nothing left
    }

    [Fact]
    public void AllocateStock_never_allocates_more_than_the_order_quantity()
    {
        var agreements = new[] { Agreement("M1", "C1", "SO1", 10m, new DateTime(2026, 1, 1)) };
        var stock = new[] { Stock("M1", availableQty: 1000m, totalQty: 0m, storageBin: "BIN1", packagingMaterial: "IB_C1_TEST") };

        var result = StockAllocationHelper.AllocateStock(agreements, stock);

        Assert.Equal(10m, result[0].DockStockAllocated);
    }

    [Fact]
    public void AllocateStock_pools_available_stock_by_material_and_packaging_customer_not_just_material()
    {
        var agreements = new[]
        {
            Agreement("M1", "ACME", "SO1", 50m, new DateTime(2026, 1, 1)),
        };
        // Stock packaged for a DIFFERENT customer's IB material doesn't pool with a plain
        // material-only stock key unless packagingCustomer matches — defaultStockKey is
        // material+packagingCustomer, defaultAgreementKey is material+customer, so these two
        // keys never actually collide in this scenario (by design — the allocation only shares
        // a pool across rows whose derived keys agree). Confirms unmatched pools don't allocate.
        var stock = new[] { Stock("M1", availableQty: 999m, totalQty: 0m, storageBin: "BIN1", packagingMaterial: "IB_OTHERCUST_5L") };

        var result = StockAllocationHelper.AllocateStock(agreements, stock);

        Assert.Equal(0m, result[0].DockStockAllocated);
    }

    [Fact]
    public void AllocateStock_sums_available_qty_across_multiple_stock_rows_for_the_same_pool()
    {
        var agreements = new[] { Agreement("M1", "C1", "SO1", 30m, new DateTime(2026, 1, 1)) };
        var stock = new[]
        {
            Stock("M1", availableQty: 10m, totalQty: 0m, storageBin: "BIN1", packagingMaterial: "IB_C1_TEST"),
            Stock("M1", availableQty: 15m, totalQty: 0m, storageBin: "BIN2", packagingMaterial: "IB_C1_TEST"),
        };

        var result = StockAllocationHelper.AllocateStock(agreements, stock);

        Assert.Equal(25m, result[0].DockStockAllocated);
    }
}
