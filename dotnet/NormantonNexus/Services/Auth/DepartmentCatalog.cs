namespace NormantonNexus.Services.Auth;

/// <summary>Display name + Razor Pages route segment for each fixed department — used by the Hub landing page (Pages/Index.cshtml). Description is a short, one-line summary shown on that page's department card; DisplayName doubles as the lookup key into Services/UI/DepartmentTheme for the card's accent colour and icon.</summary>
public static class DepartmentCatalog
{
    public sealed record Entry(string Code, string DisplayName, string Route, string Description);

    public static readonly IReadOnlyList<Entry> All =
    [
        new(NexusDepartments.Engineering, "Engineering", "/Engineering", "Packaging data & master data"),
        new(NexusDepartments.Quality, "Quality", "/Quality", "Stock blocking & concessions"),
        new(NexusDepartments.Sales, "Sales", "/Sales", "Customer instructions & schedule"),
        new(NexusDepartments.Finance, "Finance", "/Finance", "Costing & stock adjustments"),
        new(NexusDepartments.Production, "Production", "/Production", "Drumming, mixing & extrusion"),
        new(NexusDepartments.Warehouse, "Warehouse", "/Warehouse", "Stock, picksheets & staging"),
        new(NexusDepartments.Logistics, "Logistics", "/Logistics", "Shipping, purchasing & customs"),
        new(NexusDepartments.Management, "Management", "/Management", "KPIs & performance dashboard"),
    ];
}
