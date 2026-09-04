namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Pure stock-forecast math shared across Logistics Sub-phase 8b (Purchasing/
/// Performance) — port of the top-of-file shared block in routes/performance.js
/// (makeDailyUsageFn/makeIsoparDailyUsageFn/buildWeeklyStockForecast/
/// mergeWeeklyForecasts/addDaysUtc/addWorkingDaysUtc/demandOverDays/
/// findStockBelowThresholdDate). No DB/SAP access — every function here is
/// hand-verifiable in isolation, same as ConsignmentTrackerHelper's
/// ComputeReversalCancellations.
///
/// Ported now (8b.1) even though only BuildWeeklyStockForecast/MergeWeeklyForecasts
/// are wired to a live route yet (the Stock History &amp; Forecast tile's
/// /turns-valclass/history, deferred to 8b.2) — DemandOverDays/
/// FindStockBelowThresholdDate/AddWorkingDaysUtc exist for the order-suggestion
/// engine (8b.3) and Isopar stock-risk (8b.2), both of which build directly on
/// this module. Matches this migration's established "port the shared piece
/// before its real caller ships" precedent (LogisticsReferenceHelper's
/// BuildReassignmentPlanForVendorAsync, ConsignmentTrackerHelper's own header).
///
/// JS `Date` objects here map to UTC-kind <see cref="DateTime"/> throughout —
/// not <see cref="DateOnly"/> — because FindStockBelowThresholdDate's
/// same-week linear interpolation genuinely produces a sub-day time
/// component that AddWorkingDaysUtc's day-stepping must preserve (JS steps
/// via setUTCDate, which keeps the time-of-day untouched), matching the
/// existing AddWorkingDaysUtc precedent in ProductionScheduleHelper.
/// </summary>
internal static class ForecastMathHelper
{
    /// <summary>A demand adjustment window — log.DemandAdjustment shaped for makeDailyUsageFn (null bounds = unbounded).</summary>
    internal readonly record struct DemandAdjustmentWindow(DateTime? StartDate, DateTime? EndDate, decimal UsagePercent);

    /// <summary>An open order/PO expected to land on <paramref name="Date"/> — see log.PurchaseOrderSuggestion.</summary>
    internal readonly record struct IncomingDelivery(DateTime Date, decimal Qty, long? Id = null, string? PoNumber = null);

    internal sealed record ForecastDelivery(long? Id, string? PoNumber, decimal Qty, string? Material = null);

    internal sealed record ForecastWeek(string WeekEnding, decimal WeeklyUsage, decimal IncomingQty, IReadOnlyList<ForecastDelivery> Deliveries, decimal ExpectedStock);

    internal sealed record WeeklyStockForecast(string? AsOfDate, decimal CurrentStock, IReadOnlyList<ForecastWeek> Weeks, int BucketDays);

    private static decimal Round2(decimal value) => Math.Round(value, 2, MidpointRounding.AwayFromZero);

    /// <summary>
    /// Builds a (day) =&gt; dailyRate function from a 13-entry predictedMonthly array
    /// (index 0 = the month containing <paramref name="from"/>) plus any demand
    /// adjustment windows overlapping that day (first matching adjustment wins,
    /// same as Node's for..of-with-break).
    /// </summary>
    internal static Func<DateTime, decimal> MakeDailyUsageFn(IReadOnlyList<decimal> predictedMonthly, DateTime from, IReadOnlyList<DemandAdjustmentWindow>? adjustments = null)
    {
        adjustments ??= [];
        var months = new (DateTime MonthStart, DateTime MonthEnd, decimal DailyRate)[predictedMonthly.Count];
        for (var i = 0; i < predictedMonthly.Count; i++)
        {
            var monthStart = new DateTime(from.Year, from.Month, 1, 0, 0, 0, DateTimeKind.Utc).AddMonths(i);
            var monthEnd = monthStart.AddMonths(1);
            var daysInMonth = (monthEnd - monthStart).TotalDays;
            months[i] = (monthStart, monthEnd, daysInMonth > 0 ? predictedMonthly[i] / (decimal)daysInMonth : 0m);
        }

        return day =>
        {
            var rate = 0m;
            foreach (var m in months)
            {
                if (day >= m.MonthStart && day < m.MonthEnd) { rate = m.DailyRate; break; }
            }
            foreach (var adj in adjustments)
            {
                var afterStart = adj.StartDate is null || day >= adj.StartDate;
                var beforeEnd = adj.EndDate is null || day <= adj.EndDate;
                if (afterStart && beforeEnd)
                {
                    rate *= adj.UsagePercent / 100m;
                    break;
                }
            }
            return rate;
        };
    }

    /// <summary>
    /// Isopar (Material 10010) override — a fixed weekday/weekend L/day rate
    /// (log.IsoparPlanningRate) instead of SAP's PredictedUsage. Same (day) =&gt;
    /// number contract as MakeDailyUsageFn, so it drops straight into
    /// BuildWeeklyStockForecast's/DemandOverDays' dailyUsageFnOverride.
    /// </summary>
    internal static Func<DateTime, decimal> MakeIsoparDailyUsageFn(decimal weekdayRateLPerDay, decimal weekendRateLPerDay) =>
        day => day.DayOfWeek is DayOfWeek.Sunday or DayOfWeek.Saturday ? weekendRateLPerDay : weekdayRateLPerDay;

    /// <summary>
    /// The core stock projection: current stock forward-simulated bucket-by-bucket
    /// (default 7-day weeks; Isopar's single-material daily view passes bucketDays: 1
    /// — a week-wide bucket can hide a stockout/overfill landing mid-week) out to the
    /// end of the 13-month predictedMonthly horizon, crediting each open order in the
    /// week it's actually due (not up-front) before that bucket's usage is deducted.
    /// </summary>
    internal static WeeklyStockForecast BuildWeeklyStockForecast(
        decimal currentStock,
        IReadOnlyList<decimal> predictedMonthly,
        DateTime today,
        IReadOnlyList<IncomingDelivery>? incomingDeliveries = null,
        IReadOnlyList<DemandAdjustmentWindow>? adjustments = null,
        Func<DateTime, decimal>? dailyUsageFnOverride = null,
        int bucketDays = 7)
    {
        incomingDeliveries ??= [];
        adjustments ??= [];

        var start = new DateTime(today.Year, today.Month, today.Day, 0, 0, 0, DateTimeKind.Utc);

        var monthEnds = new DateTime[predictedMonthly.Count];
        for (var i = 0; i < predictedMonthly.Count; i++)
            monthEnds[i] = new DateTime(start.Year, start.Month, 1, 0, 0, 0, DateTimeKind.Utc).AddMonths(i + 1);
        var horizonEnd = monthEnds[^1];

        var dailyUsage = dailyUsageFnOverride ?? MakeDailyUsageFn(predictedMonthly, start, adjustments);

        var weeks = new List<ForecastWeek>();
        var runningStock = currentStock;
        var weekStart = start;

        while (weekStart < horizonEnd)
        {
            var candidateEnd = weekStart.AddDays(bucketDays);
            var weekEnd = candidateEnd < horizonEnd ? candidateEnd : horizonEnd;

            var deliveriesThisWeek = incomingDeliveries.Where(d => d.Date >= weekStart && d.Date < weekEnd).ToList();
            var incomingThisWeek = deliveriesThisWeek.Sum(d => d.Qty);
            runningStock += incomingThisWeek;

            var weeklyUsage = 0m;
            for (var day = weekStart; day < weekEnd; day = day.AddDays(1))
                weeklyUsage += dailyUsage(day);

            runningStock -= weeklyUsage;

            weeks.Add(new ForecastWeek(
                WeekEnding: weekEnd.ToString("yyyy-MM-dd"),
                WeeklyUsage: Round2(weeklyUsage),
                IncomingQty: Round2(incomingThisWeek),
                Deliveries: deliveriesThisWeek.Select(d => new ForecastDelivery(d.Id, d.PoNumber, Round2(d.Qty))).ToList(),
                ExpectedStock: Round2(runningStock)));

            weekStart = weekEnd;
        }

        return new WeeklyStockForecast(start.ToString("yyyy-MM-dd"), Round2(currentStock), weeks, bucketDays);
    }

    /// <summary>
    /// Sums several materials' own BuildWeeklyStockForecast results into one
    /// combined series, bucket by bucket — every forecast must share the same
    /// `today`/horizon length so their bucket grids line up exactly (safe to
    /// sum by index). Deliveries are tagged with their source material only
    /// when merging more than one material (a single-material call needs no tag).
    /// </summary>
    internal static WeeklyStockForecast MergeWeeklyForecasts(IReadOnlyList<WeeklyStockForecast> forecasts, IReadOnlyList<string>? materials = null)
    {
        materials ??= [];
        if (forecasts.Count == 0) return new WeeklyStockForecast(null, 0m, [], 7);

        var bucketCount = forecasts[0].Weeks.Count;
        var weeks = new List<ForecastWeek>();
        for (var i = 0; i < bucketCount; i++)
        {
            var deliveries = new List<ForecastDelivery>();
            for (var fi = 0; fi < forecasts.Count; fi++)
            {
                foreach (var d in forecasts[fi].Weeks[i].Deliveries)
                    deliveries.Add(materials.Count > 1 ? d with { Material = materials[fi] } : d);
            }

            weeks.Add(new ForecastWeek(
                WeekEnding: forecasts[0].Weeks[i].WeekEnding,
                WeeklyUsage: Round2(forecasts.Sum(f => f.Weeks[i].WeeklyUsage)),
                IncomingQty: Round2(forecasts.Sum(f => f.Weeks[i].IncomingQty)),
                Deliveries: deliveries,
                ExpectedStock: Round2(forecasts.Sum(f => f.Weeks[i].ExpectedStock))));
        }

        return new WeeklyStockForecast(forecasts[0].AsOfDate, Round2(forecasts.Sum(f => f.CurrentStock)), weeks, forecasts[0].BucketDays);
    }

    /// <summary>
    /// SAP's PLIFZ and this app's manually-maintained lead/transit time fields are
    /// working days, not calendar days — every date calculation actually driven by
    /// a lead or transit time skips Saturdays and Sundays. Calendar-day math
    /// (demand/coverage spreading, the order-review horizon) stays on plain
    /// AddDays instead, since stock keeps depleting over a weekend regardless of
    /// whether a supplier is open. Fractional lead times are rounded to the
    /// nearest whole day before stepping.
    /// </summary>
    internal static DateTime AddWorkingDaysUtc(DateTime date, decimal days)
    {
        var result = date;
        var step = days >= 0 ? 1 : -1;
        var remaining = (int)Math.Round(Math.Abs(days), MidpointRounding.AwayFromZero);
        while (remaining > 0)
        {
            result = result.AddDays(step);
            if (result.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday))
                remaining--;
        }
        return result;
    }

    /// <summary>
    /// Demand between `from` and `from + days`, using the same day-by-day dailyUsage
    /// as BuildWeeklyStockForecast so a demand adjustment applies identically here as
    /// it does to the graph — used for the order-suggestion sizing calculation, which
    /// needs a demand total over an arbitrary day-count rather than the bucketed series.
    /// </summary>
    internal static decimal DemandOverDays(IReadOnlyList<decimal> predictedMonthly, DateTime from, decimal days, IReadOnlyList<DemandAdjustmentWindow>? adjustments = null, Func<DateTime, decimal>? dailyUsageFnOverride = null)
    {
        var rangeEnd = from.AddDays((double)days);
        var dailyUsage = dailyUsageFnOverride ?? MakeDailyUsageFn(predictedMonthly, from, adjustments ?? []);
        var total = 0m;
        for (var day = from; day < rangeEnd; day = day.AddDays(1))
            total += dailyUsage(day);
        return total;
    }

    /// <summary>
    /// First date a weekly forecast's ExpectedStock drops to/below `threshold` (the
    /// material's safety-stock floor, not necessarily zero), with a same-week linear
    /// interpolation so the result is a day rather than only ever landing on a
    /// bucket-ending date. Null when never projected to breach the floor within the horizon.
    /// </summary>
    internal static DateTime? FindStockBelowThresholdDate(WeeklyStockForecast weeklyForecast, DateTime asOfDate, decimal threshold)
    {
        var prevStock = weeklyForecast.CurrentStock;
        var weekStart = asOfDate;
        foreach (var w in weeklyForecast.Weeks)
        {
            var weekEnd = DateTime.SpecifyKind(DateTime.Parse(w.WeekEnding), DateTimeKind.Utc);
            if (w.ExpectedStock <= threshold)
            {
                var drop = prevStock - w.ExpectedStock;
                var frac = drop > 0 ? Math.Max(0m, Math.Min(1m, (prevStock - threshold) / drop)) : 0m;
                var weekTicks = (weekEnd - weekStart).Ticks;
                return weekStart.AddTicks((long)(frac * weekTicks));
            }
            prevStock = w.ExpectedStock;
            weekStart = weekEnd;
        }
        return null;
    }
}
