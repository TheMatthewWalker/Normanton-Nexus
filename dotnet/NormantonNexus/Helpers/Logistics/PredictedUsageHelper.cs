namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Predicted usage — a seasonal-index weighted forecast built from 36 months
/// of consumption history (SapTurnsValClassRow.ConsumptionHistory36) —
/// Logistics Sub-phase 8b.6. Port of routes/performanceforecast.js.
///
/// Why this exists: SAP's own demand forecast (Z_STOCK_REQ_LIST) only
/// reflects orders that already exist in the system — in practice that's
/// about 1-2 months of real visibility. Materials are bought from suppliers
/// on a ~4-month lead time, so there's a 2+ month gap where SAP shows
/// nothing but a purchase decision still has to be made. Predicted usage
/// fills that gap with a statistical estimate based on how the material has
/// actually been consumed historically.
///
/// Method: classic seasonal-index decomposition — separates "how much do we
/// use right now" (baseLevel, trailing 12-month average) from "how does this
/// particular calendar month typically differ from the yearly average"
/// (seasonalIndex, a weighted average of that calendar month's historical
/// values from the last up-to-3 years — most recent year weighted 3x, then
/// 2x, then 1x — divided by the full 36-month overall average). Multiplying
/// a trend-aware level by a seasonal ratio (rather than just replaying
/// whatever happened in that calendar month 1-3 years ago) means a rising or
/// falling overall trend still comes through, while the shape of the year is
/// still respected.
/// </summary>
internal static class PredictedUsageHelper
{
    private static readonly int[] YearWeights = [3, 2, 1]; // most-recent-year first; renormalised over whichever years actually have data
    private const decimal MaxSeasonalIndex = 4m; // safety clamp — stops a near-zero overallAverage (low-volume/sparse materials) from amplifying noise into an absurd multiple of baseLevel

    /// <param name="history36">36 months of consumption, oldest first, current month last (index 35 = current month, index 0 = 35 months ago) — same array shape as SapTurnsValClassRow.ConsumptionHistory36. A history that isn't exactly 36 long is treated as all-zero, matching Node's own defensive fallback.</param>
    /// <returns>13-element predicted usage, index 0 = current month, index 12 = +12 months out — same shape/orientation as DemandForecast, so both can share the same chart timeline and SQL column layout.</returns>
    internal static decimal[] ComputePredictedUsage(IReadOnlyList<decimal>? history36)
    {
        var h = history36 is { Count: 36 } ? history36 : new decimal[36];

        // offset: 0 = current month, negative = that many months ago. Valid range -35..0.
        // Returns null (not 0) outside that range so "no data that far back" can be
        // distinguished from "genuinely zero consumption that month".
        decimal? ValueAtOffset(int offset)
        {
            var idx = 35 + offset;
            return idx >= 0 && idx < 36 ? h[idx] : null;
        }

        var baseLevel = Average(h.Skip(24).Take(12)); // last 12 months
        var overallAverage = Average(h); // full 36-month window

        var predicted = new decimal[13];
        for (var k = 0; k <= 12; k++)
        {
            if (overallAverage <= 0) { predicted[k] = 0; continue; }

            var seasonalRaw = WeightedSeasonalValue(k, ValueAtOffset);
            var seasonalIndex = Math.Min(MaxSeasonalIndex, seasonalRaw / overallAverage);

            predicted[k] = Math.Max(0, baseLevel * seasonalIndex);
        }

        return predicted;
    }

    /// <summary>Same calendar month 1/2/3 years before the TARGET month (today + k), expressed as an offset from today: k-12, k-24, k-36. Averages whichever of those are actually available (early on, or for large k, the 3-years-back observation can fall just outside the 36-month window — dropped and renormalised over what's left).</summary>
    private static decimal WeightedSeasonalValue(int k, Func<int, decimal?> valueAtOffset)
    {
        var observations = new (decimal? Value, int Weight)[]
        {
            (valueAtOffset(k - 12), YearWeights[0]),
            (valueAtOffset(k - 24), YearWeights[1]),
            (valueAtOffset(k - 36), YearWeights[2]),
        }.Where(o => o.Value is not null).ToList();

        if (observations.Count == 0) return 0;

        var weightSum = observations.Sum(o => o.Weight);
        return observations.Sum(o => o.Value!.Value * o.Weight) / weightSum;
    }

    private static decimal Average(IEnumerable<decimal> values)
    {
        var list = values as IReadOnlyList<decimal> ?? values.ToList();
        return list.Count == 0 ? 0 : list.Sum() / list.Count;
    }
}
