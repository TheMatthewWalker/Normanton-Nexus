using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Isopar Tied Oil (Material 10010) — Logistics Sub-phase 8b.2. Port of
/// routes/performance.js's /isopar/readings, /isopar/stock-risk and
/// /isopar/planning-rate routes + their performancesql.js backing queries.
/// Declarations (ISOPAR_DECL-gated) are deferred to Sub-phase 8b.6.
/// </summary>
internal static class IsoparHelper
{
    // ── Meter readings (log.IsoparMeterReading) ──────────────────────────

    internal static async Task<IReadOnlyList<IsoparReadingRow>> ListReadingsAsync(INexusOperationsDb db, DateTime? from, DateTime? to, CancellationToken ct)
    {
        var where = new List<string>();
        if (from.HasValue) where.Add("ReadingDate >= @from");
        if (to.HasValue) where.Add("ReadingDate <= @to");
        var whereSql = where.Count > 0 ? $"WHERE {string.Join(" AND ", where)}" : "";

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<IsoparReadingRow>(new CommandDefinition($"""
            SELECT ReadingId, ReadingDate, ReadingQty, Notes, CreatedBy, CreatedAtUtc, UpdatedAtUtc
            FROM log.IsoparMeterReading
            {whereSql}
            ORDER BY ReadingDate DESC
            """, new { from, to }, cancellationToken: ct));
        return rows.AsList();
    }

    private static async Task<IsoparReadingRow?> GetLatestReadingAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleOrDefaultAsync<IsoparReadingRow?>(new CommandDefinition("""
            SELECT TOP 1 ReadingId, ReadingDate, ReadingQty, Notes, CreatedBy, CreatedAtUtc, UpdatedAtUtc
            FROM log.IsoparMeterReading
            ORDER BY ReadingDate DESC
            """, cancellationToken: ct));
    }

    /// <summary>
    /// Reject-duplicate-date, not upsert — an accidental resubmit for a day already logged should
    /// surface as an explicit error (mirroring the demand-adjustment overlap rejection), not
    /// silently overwrite a different value. UQ_IsoparMeterReading_ReadingDate is the DB-level
    /// backstop behind this check.
    /// </summary>
    internal static async Task<long> CreateReadingAsync(INexusOperationsDb db, CreateIsoparReadingRequest body, string? createdBy, CancellationToken ct)
    {
        if (body.ReadingDate is null) throw new NexusValidationException("readingDate is required.");
        if (body.ReadingQty is null || body.ReadingQty < 0) throw new NexusValidationException("readingQty is required and cannot be negative.");

        using var connection = await db.CreateConnectionAsync(ct);
        var existing = await connection.QueryFirstOrDefaultAsync<int?>(new CommandDefinition(
            "SELECT 1 FROM log.IsoparMeterReading WHERE ReadingDate = @readingDate", new { readingDate = body.ReadingDate }, cancellationToken: ct));
        if (existing is not null)
            throw new NexusValidationException($"A reading already exists for {body.ReadingDate:yyyy-MM-dd} — edit it instead of adding a second one.");

        return await connection.QuerySingleAsync<long>(new CommandDefinition("""
            INSERT INTO log.IsoparMeterReading (ReadingDate, ReadingQty, Notes, CreatedBy)
            OUTPUT INSERTED.ReadingId
            VALUES (@ReadingDate, @ReadingQty, @Notes, @createdBy)
            """, new { body.ReadingDate, body.ReadingQty, body.Notes, createdBy }, cancellationToken: ct));
    }

    /// <summary>ReadingDate is deliberately NOT editable — a wrong date is a delete-and-recreate, not an edit.</summary>
    internal static async Task UpdateReadingAsync(INexusOperationsDb db, long readingId, UpdateIsoparReadingRequest body, CancellationToken ct)
    {
        if (body.ReadingQty is null || body.ReadingQty < 0) throw new NexusValidationException("readingQty is required and cannot be negative.");

        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.IsoparMeterReading SET ReadingQty = @ReadingQty, Notes = @Notes, UpdatedAtUtc = GETUTCDATE()
            WHERE ReadingId = @readingId
            """, new { readingId, body.ReadingQty, body.Notes }, cancellationToken: ct));
    }

    internal static async Task DeleteReadingAsync(INexusOperationsDb db, long readingId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("DELETE FROM log.IsoparMeterReading WHERE ReadingId = @readingId", new { readingId }, cancellationToken: ct));
    }

    /// <summary>One call for the order-suggestion engine's buildSuggestionForRow/preview (8b.3) — the latest meter reading + current planning rate together, matching Node's getIsoparForecastContext.</summary>
    internal static async Task<IsoparForecastContext> GetForecastContextAsync(INexusOperationsDb db, CancellationToken ct)
    {
        var latestReading = await GetLatestReadingAsync(db, ct);
        var planningRate = await GetPlanningRateAsync(db, ct);
        return new IsoparForecastContext(latestReading, planningRate);
    }

    // ── Planning rate (log.IsoparPlanningRate — versioned, "current" = latest row) ──

    private static async Task<IsoparPlanningRateRow?> GetPlanningRateAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleOrDefaultAsync<IsoparPlanningRateRow?>(new CommandDefinition("""
            SELECT TOP 1 RateId, WeekdayRateLPerDay, WeekendRateLPerDay, MaxStockCapacityQty, Source, Notes, CreatedBy, CreatedAtUtc
            FROM log.IsoparPlanningRate
            ORDER BY RateId DESC
            """, cancellationToken: ct));
    }

    /// <summary>
    /// The "actual" block is the measured average consumption from real consecutive-day reading
    /// pairs only (a missed day just isn't counted rather than interpolated — simple and
    /// hand-verifiable). "recommendation" is present only when actual meaningfully (&gt;5%) differs
    /// from the currently configured rate and there's enough data (&gt;=5 sample intervals) to trust
    /// it — the UI offers a one-click "Apply" that PUTs it as a new Source:'Recommended' version;
    /// nothing is ever silently auto-applied.
    /// </summary>
    internal static async Task<IsoparPlanningRateResult> GetPlanningRateWithRecommendationAsync(INexusOperationsDb db, CancellationToken ct)
    {
        var current = await GetPlanningRateAsync(db, ct);
        var readings = await ListReadingsAsync(db, null, null, ct);
        return ComputePlanningRateRecommendation(current, readings);
    }

    /// <summary>
    /// Pure "actual consumption from consecutive-day reading pairs, plus an optional recommendation"
    /// computation — exposed internal for direct unit testing without a DB.
    /// </summary>
    internal static IsoparPlanningRateResult ComputePlanningRateRecommendation(IsoparPlanningRateRow? current, IReadOnlyList<IsoparReadingRow> readings)
    {
        var sorted = readings.OrderBy(r => r.ReadingDate).ToList();
        var weekdayIntervals = new List<decimal>();
        var weekendIntervals = new List<decimal>();
        for (var i = 1; i < sorted.Count; i++)
        {
            var prev = sorted[i - 1];
            var curr = sorted[i];
            var dayGap = (int)Math.Round((curr.ReadingDate - prev.ReadingDate).TotalDays, MidpointRounding.AwayFromZero);
            if (dayGap != 1) continue; // only strictly-consecutive 1-day-apart pairs count

            var consumed = prev.ReadingQty - curr.ReadingQty; // deliveries netted out separately is intentionally skipped here, matching Node
            var target = curr.ReadingDate.DayOfWeek is DayOfWeek.Sunday or DayOfWeek.Saturday ? weekendIntervals : weekdayIntervals;
            target.Add(consumed);
        }

        decimal? Avg(List<decimal> values) => values.Count > 0 ? values.Average() : null;
        var actual = new IsoparPlanningRateActual(
            Avg(weekdayIntervals), Avg(weekendIntervals), weekdayIntervals.Count + weekendIntervals.Count,
            sorted.Count > 0 ? sorted[0].ReadingDate : null, sorted.Count > 0 ? sorted[^1].ReadingDate : null);

        IsoparPlanningRateRecommendation? recommendation = null;
        if (current is not null && actual.WeekdayAvgLPerDay is not null && actual.WeekendAvgLPerDay is not null && actual.SampleIntervals >= 5)
        {
            var weekdayDiff = Math.Abs(actual.WeekdayAvgLPerDay.Value - current.WeekdayRateLPerDay) / Math.Max(1m, current.WeekdayRateLPerDay);
            var weekendDiff = Math.Abs(actual.WeekendAvgLPerDay.Value - current.WeekendRateLPerDay) / Math.Max(1m, current.WeekendRateLPerDay);
            if (weekdayDiff > 0.05m || weekendDiff > 0.05m)
            {
                recommendation = new IsoparPlanningRateRecommendation(
                    Math.Round(actual.WeekdayAvgLPerDay.Value, 2, MidpointRounding.AwayFromZero),
                    Math.Round(actual.WeekendAvgLPerDay.Value, 2, MidpointRounding.AwayFromZero));
            }
        }

        return new IsoparPlanningRateResult(current, actual, recommendation);
    }

    /// <summary>Partial update — a field left null carries forward from the current row rather than resetting to null, since editing just the weekday rate shouldn't silently blank out the tank capacity.</summary>
    internal static async Task<long> UpdatePlanningRateAsync(INexusOperationsDb db, UpdateIsoparPlanningRateRequest body, string? createdBy, CancellationToken ct)
    {
        if (body.WeekdayRateLPerDay is < 0) throw new NexusValidationException("weekdayRateLPerDay cannot be negative.");
        if (body.WeekendRateLPerDay is < 0) throw new NexusValidationException("weekendRateLPerDay cannot be negative.");
        if (body.MaxStockCapacityQty is < 0) throw new NexusValidationException("maxStockCapacityQty cannot be negative.");

        var current = await GetPlanningRateAsync(db, ct);
        var weekdayRate = body.WeekdayRateLPerDay ?? current?.WeekdayRateLPerDay ?? 0m;
        var weekendRate = body.WeekendRateLPerDay ?? current?.WeekendRateLPerDay ?? 0m;
        var maxCapacity = body.MaxStockCapacityQty ?? current?.MaxStockCapacityQty;

        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleAsync<long>(new CommandDefinition("""
            INSERT INTO log.IsoparPlanningRate (WeekdayRateLPerDay, WeekendRateLPerDay, MaxStockCapacityQty, Source, Notes, CreatedBy)
            OUTPUT INSERTED.RateId
            VALUES (@weekdayRate, @weekendRate, @maxCapacity, @source, @notes, @createdBy)
            """, new { weekdayRate, weekendRate, maxCapacity, source = body.Source ?? "Manual", notes = body.Notes, createdBy }, cancellationToken: ct));
    }

    // ── Stock risk (forecast integration) ────────────────────────────────

    /// <summary>
    /// Rebuilds the live Isopar forecast (latest meter reading + weekday/weekend rate + any real
    /// pending deliveries already accepted for it) and flags whether it implies running out
    /// (expectedStock &lt;= 0) or overfilling the tank (expectedStock &gt; MaxStockCapacityQty).
    /// Null when there's nothing to flag (or no reading/rate configured yet to check against).
    ///
    /// Bounded to a near-term window rather than the full 13-month horizon: with no pending
    /// delivery, an unconstrained forecast will ALWAYS eventually hit zero (nothing replenishes it
    /// on its own), which would make this "risk" permanently true and useless as a warning.
    /// OrderReviewHorizonDays (the same "how far ahead is a shortage worth surfacing" window the
    /// rest of MRP uses) is the default check window, extended out to cover whatever pending
    /// delivery lands furthest away (plus a short buffer) so an overfill risk tied to a later
    /// delivery is still caught.
    /// </summary>
    internal static async Task<IsoparStockRiskResult?> ComputeStockRiskAsync(INexusOperationsDb db, CancellationToken ct)
    {
        var latestReading = await GetLatestReadingAsync(db, ct);
        var planningRate = await GetPlanningRateAsync(db, ct);
        var incoming = await PurchaseOrderSuggestionHelper.ListOpenIncomingOrdersAsync(db, [IsoparPeriodHelper.IsoparMaterial], ct);

        return ComputeStockRisk(latestReading, planningRate, incoming, DateTime.UtcNow);
    }

    /// <summary>
    /// Pure stock-risk computation given already-fetched data — exposed internal for direct unit
    /// testing without a DB. Null when there's no reading/rate configured yet, or nothing to flag.
    /// </summary>
    internal static IsoparStockRiskResult? ComputeStockRisk(IsoparReadingRow? latestReading, IsoparPlanningRateRow? planningRate, IReadOnlyList<OpenIncomingOrderRow> incoming, DateTime now)
    {
        if (latestReading is null || planningRate is null) return null;

        var onHandStock = latestReading.ReadingQty;
        var dailyUsageFnOverride = ForecastMathHelper.MakeIsoparDailyUsageFn(planningRate.WeekdayRateLPerDay, planningRate.WeekendRateLPerDay);
        var incomingDeliveries = incoming
            .Where(o => o.DeliveryDate.HasValue)
            .Select(o => new ForecastMathHelper.IncomingDelivery(o.DeliveryDate!.Value, o.OrderQty, o.SuggestionId, o.PoNumber))
            .ToList();

        // predictedMonthly is irrelevant here (dailyUsageFnOverride replaces it entirely) — the
        // 13-zero array only sizes BuildWeeklyStockForecast's usual 13-month horizon. bucketDays: 1
        // — Isopar's tank is small enough relative to daily usage that the default 7-day bucket
        // could put the actual stockout/overfill date up to 6 days later than reported, which
        // defeats the point of a "warn me before it happens" banner.
        var forecast = ForecastMathHelper.BuildWeeklyStockForecast(onHandStock, new decimal[13], now, incomingDeliveries, [], dailyUsageFnOverride, bucketDays: 1);
        var maxCapacity = planningRate.MaxStockCapacityQty;

        var reviewHorizonEnd = now.Date.AddDays(PurchaseOrderSuggestionHelper.OrderReviewHorizonDays);
        var latestDeliveryDate = incomingDeliveries.Count > 0 ? incomingDeliveries.Max(d => d.Date) : (DateTime?)null;
        var horizonEnd = latestDeliveryDate.HasValue && latestDeliveryDate.Value > reviewHorizonEnd
            ? latestDeliveryDate.Value.AddDays(7)
            : reviewHorizonEnd;

        var weeksInWindow = forecast.Weeks.Where(w => DateTime.SpecifyKind(DateTime.Parse(w.WeekEnding), DateTimeKind.Utc) <= horizonEnd).ToList();

        var stockoutDate = onHandStock <= 0
            ? forecast.AsOfDate
            : weeksInWindow.FirstOrDefault(w => w.ExpectedStock <= 0)?.WeekEnding;

        var overCapacityDate = maxCapacity.HasValue
            ? (onHandStock > maxCapacity.Value ? forecast.AsOfDate : weeksInWindow.FirstOrDefault(w => w.ExpectedStock > maxCapacity.Value)?.WeekEnding)
            : null;

        if (stockoutDate is null && overCapacityDate is null) return null;

        return new IsoparStockRiskResult(forecast.AsOfDate, onHandStock, maxCapacity, stockoutDate, overCapacityDate);
    }
}
