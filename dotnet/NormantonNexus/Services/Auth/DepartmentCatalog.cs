namespace NormantonNexus.Services.Auth;

/// <summary>Display name + Razor Pages route segment for each fixed department — used by the Hub landing page (Pages/Index.cshtml).</summary>
public static class DepartmentCatalog
{
    public sealed record Entry(string Code, string DisplayName, string Route);

    public static readonly IReadOnlyList<Entry> All =
    [
        new(NexusDepartments.Engineering, "Engineering", "/Engineering"),
        new(NexusDepartments.Quality, "Quality", "/Quality"),
        new(NexusDepartments.Sales, "Sales", "/Sales"),
        new(NexusDepartments.Finance, "Finance", "/Finance"),
        new(NexusDepartments.Production, "Production", "/Production"),
        new(NexusDepartments.Warehouse, "Warehouse", "/Warehouse"),
        new(NexusDepartments.Logistics, "Logistics", "/Logistics"),
        new(NexusDepartments.Management, "Management", "/Management"),
    ];
}
