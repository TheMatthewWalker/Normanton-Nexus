namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Weight unit conversion — port of lib/unitConversion.js. Some vendors
/// (e.g. DeWAL) require purchase orders placed in a unit other than the
/// material's SAP base unit (almost always KG in this system —
/// see log.TurnsValClassSnapshot.Uom); the vendor's required order unit is
/// recorded on log.Vendor.OrderMoqUom (Vendor Master Data page — Sub-phase
/// 8b.2). Everywhere else in this app (stock, forecast, MRP suggestion math)
/// deliberately stays in the material's SAP base unit — only the SAP PO
/// build, the PO PDF, and the goods-receipt quantity actually cross that
/// boundary (Sub-phase 8b.7).
///
/// KgPerUnit is deliberately small (only units actually in use), not a
/// general-purpose conversion library — ConvertQty throws on anything not
/// listed instead of silently treating an unknown unit as a no-op.
/// </summary>
internal static class UnitConversionHelper
{
    private static readonly IReadOnlyDictionary<string, decimal> KgPerUnit = new Dictionary<string, decimal>
    {
        ["KG"] = 1m,
        ["LB"] = 0.45359237m,
    };

    internal static decimal ConvertQty(decimal qty, string? fromUnit, string? toUnit)
    {
        var from = (fromUnit ?? "KG").ToUpperInvariant();
        var to = (toUnit ?? "KG").ToUpperInvariant();
        if (from == to) return qty;

        if (!KgPerUnit.TryGetValue(from, out var fromFactor) || !KgPerUnit.TryGetValue(to, out var toFactor))
            throw new InvalidOperationException($"Unsupported unit conversion: {fromUnit} -> {toUnit}");

        return qty * fromFactor / toFactor;
    }
}
