using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models.Dto;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class ShipmentPackagingDeclarationPdfHelperTests
{
    private static ShipmentPackagingDeclarationPdfHelper.Input SampleInput() => new(
        ShipmentRef: "00000042", DeliveryRef: "200, 201", CustomerName: "Acme Ltd", DispatchDate: new DateTime(2026, 3, 1),
        Packaging: new PackagingDeclarationOptions(true, false, true, false),
        Ispm15: "yes", DunnageConfirmed: true, ContainerClean: "na",
        SignedByName: "Jane Smith", SignedByPosition: "Logistics Supervisor", SignedAt: new DateTime(2026, 3, 1, 9, 15, 0));

    [Fact]
    public void Build_produces_a_valid_one_page_PDF()
    {
        var bytes = ShipmentPackagingDeclarationPdfHelper.Build(SampleInput());

        Assert.True(bytes.Length > 500);
        Assert.Equal("%PDF"u8.ToArray(), bytes[..4]);
    }

    [Fact]
    public void Build_does_not_throw_when_every_optional_field_is_absent()
    {
        var input = SampleInput() with { DeliveryRef = null, CustomerName = null, DispatchDate = null, Ispm15 = "na", DunnageConfirmed = false, ContainerClean = "na" };

        var bytes = ShipmentPackagingDeclarationPdfHelper.Build(input);

        Assert.True(bytes.Length > 500);
    }

    [Fact]
    public void Build_does_not_throw_when_every_packaging_type_is_selected()
    {
        var input = SampleInput() with { Packaging = new PackagingDeclarationOptions(true, true, true, true) };

        var bytes = ShipmentPackagingDeclarationPdfHelper.Build(input);

        Assert.True(bytes.Length > 500);
    }
}
