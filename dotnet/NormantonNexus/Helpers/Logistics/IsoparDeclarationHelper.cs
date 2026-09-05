using System.Data;
using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Notifications;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// HMRC Tied Oil declarations (log.IsoparDeclaration) — Logistics Sub-phase
/// 8b.6. Port of routes/performance.js's "Declarations" section + its
/// performancesql.js backing queries + checkIsoparDeclarationDue. Gated
/// ISOPAR_DECL (separate from the rest of Isopar planning's LOG_MRP gate —
/// only whoever actually files the HMRC return needs to see/confirm this),
/// enforced by the controller.
/// </summary>
internal static class IsoparDeclarationHelper
{
    private static decimal Round3(decimal v) => Math.Round(v, 3, MidpointRounding.AwayFromZero);

    // ── Period figures — shared by the live outstanding-period preview and the frozen submit path ──

    internal static async Task<IsoparReadingRow?> GetReadingOnOrBeforeAsync(IDbConnection connection, DateTime date, CancellationToken ct) =>
        await connection.QuerySingleOrDefaultAsync<IsoparReadingRow?>(new CommandDefinition("""
            SELECT TOP 1 ReadingId, ReadingDate, ReadingQty, Notes, CreatedBy, CreatedAtUtc, UpdatedAtUtc
            FROM log.IsoparMeterReading
            WHERE ReadingDate <= @date
            ORDER BY ReadingDate DESC
            """, new { date }, cancellationToken: ct));

    internal static async Task<IReadOnlyList<IsoparReceivedDeliveryRow>> ListReceivedDeliveriesInRangeAsync(IDbConnection connection, DateTime periodStart, DateTime periodEndInclusive, CancellationToken ct)
    {
        var periodEndExclusive = periodEndInclusive.AddDays(1);
        var rows = await connection.QueryAsync<IsoparReceivedDeliveryRow>(new CommandDefinition("""
            SELECT p.SuggestionId, p.OrderQty, p.ReceivedQty, p.PoNumber,
                   COALESCE(p.ReceivedAtUtc, s.ReceivedAtUtc) AS ReceivedDate
            FROM log.PurchaseOrderSuggestion p
            LEFT JOIN log.PurchaseOrderShipment s ON s.ShipmentId = p.ShipmentId
            WHERE p.Material = @material
              AND p.Status IN ('Booked', 'Received')
              AND COALESCE(p.ReceivedAtUtc, s.ReceivedAtUtc) >= @periodStart
              AND COALESCE(p.ReceivedAtUtc, s.ReceivedAtUtc) < @periodEndExclusive
            """, new { material = IsoparPeriodHelper.IsoparMaterial, periodStart, periodEndExclusive }, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<IsoparPeriodFigures> ComputePeriodFiguresAsync(INexusOperationsDb db, DateTime periodStart, DateTime periodEnd, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var openingTask = GetReadingOnOrBeforeAsync(connection, periodStart, ct);
        var closingTask = GetReadingOnOrBeforeAsync(connection, periodEnd, ct);
        var deliveriesTask = ListReceivedDeliveriesInRangeAsync(connection, periodStart, periodEnd, ct);
        await Task.WhenAll(openingTask, closingTask, deliveriesTask);

        var openingReading = await openingTask;
        var closingReading = await closingTask;
        var deliveries = await deliveriesTask;

        var receivedQty = Round3(deliveries.Sum(d => d.ReceivedQty ?? d.OrderQty));
        var openingStockQty = openingReading?.ReadingQty;
        var closingStockQty = closingReading?.ReadingQty;
        var consumedQty = openingStockQty is not null && closingStockQty is not null
            ? Round3(openingStockQty.Value + receivedQty - closingStockQty.Value)
            : (decimal?)null;

        return new IsoparPeriodFigures(periodStart, periodEnd, openingReading, closingReading,
            openingStockQty, closingStockQty, receivedQty, consumedQty, deliveries,
            Complete: openingStockQty is not null && closingStockQty is not null);
    }

    // ── Declarations (log.IsoparDeclaration, frozen once submitted) ──────

    internal static async Task<IReadOnlyList<IsoparDeclarationRow>> ListDeclarationsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await ListDeclarationsAsync(connection, ct);
    }

    private static async Task<IReadOnlyList<IsoparDeclarationRow>> ListDeclarationsAsync(IDbConnection connection, CancellationToken ct)
    {
        var rows = await connection.QueryAsync<IsoparDeclarationRow>(new CommandDefinition("""
            SELECT DeclarationId, PeriodStart, PeriodEnd, OpeningStockQty, ReceivedQty, ClosingStockQty,
                   ConsumedQty, OpeningReadingId, ClosingReadingId, Notes,
                   SubmittedByUserId, SubmittedByUsername, SubmittedAtUtc
            FROM log.IsoparDeclaration
            ORDER BY PeriodStart DESC
            """, cancellationToken: ct));
        return rows.AsList();
    }

    private static async Task<long?> GetDeclarationIdForPeriodAsync(IDbConnection connection, DateTime periodStart, DateTime periodEnd, CancellationToken ct) =>
        await connection.QuerySingleOrDefaultAsync<long?>(new CommandDefinition("""
            SELECT TOP 1 DeclarationId FROM log.IsoparDeclaration
            WHERE PeriodStart = @periodStart AND PeriodEnd = @periodEnd
            """, new { periodStart, periodEnd }, cancellationToken: ct));

    /// <summary>Every period that has fully ended as of `today` but has no matching log.IsoparDeclaration row yet, oldest first — diffed in memory against the pure IsoparPeriodHelper.IsoparPeriodsEndedBefore list rather than one query per period.</summary>
    internal static async Task<IReadOnlyList<IsoparPeriodHelper.IsoparPeriodEnded>> ListOutstandingPeriodsAsync(INexusOperationsDb db, DateTime today, CancellationToken ct)
    {
        var ended = IsoparPeriodHelper.IsoparPeriodsEndedBefore(today);
        if (ended.Count == 0) return [];

        using var connection = await db.CreateConnectionAsync(ct);
        var declared = await ListDeclarationsAsync(connection, ct);
        var declaredKeys = declared.Select(d => (d.PeriodStart, d.PeriodEnd)).ToHashSet();
        return ended.Where(p => !declaredKeys.Contains((p.Start, p.End))).ToList();
    }

    internal static async Task<CreateIsoparDeclarationResult> CreateDeclarationAsync(INexusOperationsDb db, CreateIsoparDeclarationRequest body, int submittedByUserId, string? submittedByUsername, CancellationToken ct)
    {
        if (body.PeriodStart is null || body.PeriodEnd is null)
            throw new NexusValidationException("periodStart and periodEnd are required.");

        var periodStart = body.PeriodStart.Value;
        var periodEnd = body.PeriodEnd.Value;

        var outstanding = await ListOutstandingPeriodsAsync(db, DateTime.UtcNow, ct);
        if (!outstanding.Any(p => p.Start == periodStart && p.End == periodEnd))
            throw new NexusValidationException("That period is not currently outstanding — it may already be submitted, not yet ended, or not a valid Isopar declaration period.");

        var figures = await ComputePeriodFiguresAsync(db, periodStart, periodEnd, ct);
        if (!figures.Complete)
            throw new NexusValidationException("Cannot submit — a meter reading is missing for the opening or closing date of this period.");

        using var connection = await db.CreateConnectionAsync(ct);

        var existing = await GetDeclarationIdForPeriodAsync(connection, periodStart, periodEnd, ct);
        if (existing is not null)
            throw new NexusValidationException("A declaration for this period has already been submitted.");

        var declarationId = await connection.QuerySingleAsync<long>(new CommandDefinition("""
            INSERT INTO log.IsoparDeclaration (
                PeriodStart, PeriodEnd, OpeningStockQty, ReceivedQty, ClosingStockQty, ConsumedQty,
                OpeningReadingId, ClosingReadingId, CalculationSnapshotJson, Notes,
                SubmittedByUserId, SubmittedByUsername
            )
            OUTPUT INSERTED.DeclarationId
            VALUES (
                @periodStart, @periodEnd, @openingStockQty, @receivedQty, @closingStockQty, @consumedQty,
                @openingReadingId, @closingReadingId, @calculationSnapshotJson, @notes,
                @submittedByUserId, @submittedByUsername
            )
            """, new
        {
            periodStart,
            periodEnd,
            openingStockQty = figures.OpeningStockQty,
            receivedQty = figures.ReceivedQty,
            closingStockQty = figures.ClosingStockQty,
            consumedQty = figures.ConsumedQty,
            openingReadingId = figures.OpeningReading?.ReadingId,
            closingReadingId = figures.ClosingReading?.ReadingId,
            calculationSnapshotJson = System.Text.Json.JsonSerializer.Serialize(new { figures.OpeningReading, figures.ClosingReading, figures.Deliveries }),
            notes = body.Notes,
            submittedByUserId,
            submittedByUsername,
        }, cancellationToken: ct));

        return new CreateIsoparDeclarationResult(declarationId);
    }

    /// <summary>
    /// Run daily via a Quartz.NET job once Phase 10 wires up cron scheduling (no HTTP route
    /// calls this in Node either — it's cron-only there too) — warns whoever holds ISOPAR_DECL
    /// that a period has ended and needs submitting. Self-healing/idempotent rather than
    /// exact-day-gated: it checks dbo.Notifications for a title naming this specific period's
    /// end date before sending, so a missed/late run just catches up the next day instead of
    /// silently skipping a quarter (same insert-once philosophy as
    /// PerformanceSnapshotHelper.UpsertForecastAccuracyLogAsync's current-month freeze).
    /// </summary>
    internal static async Task<IsoparDeclarationDueCheckResult> CheckDeclarationDueAsync(INexusDb nexusDb, INexusOperationsDb opsDb, INotificationService notify, CancellationToken ct)
    {
        var outstanding = await ListOutstandingPeriodsAsync(opsDb, DateTime.UtcNow, ct);
        if (outstanding.Count == 0) return new IsoparDeclarationDueCheckResult(Notified: false);

        // Only the oldest outstanding period — if several have piled up, one clear notification
        // beats a flood of near-duplicates; the next day's run naturally surfaces the next-oldest
        // once this one's submitted.
        var period = outstanding[0];
        var periodEndLabel = period.End.ToString("yyyy-MM-dd");
        var title = $"Isopar Tied Oil declaration due — period ending {periodEndLabel}";

        using var connection = await nexusDb.CreateConnectionAsync(ct);
        var existingId = await connection.QuerySingleOrDefaultAsync<int?>(new CommandDefinition(
            "SELECT TOP 1 NotificationID FROM dbo.Notifications WHERE Title = @title", new { title }, cancellationToken: ct));
        if (existingId is not null) return new IsoparDeclarationDueCheckResult(Notified: false, AlreadySent: true);

        await notify.NotifyAsync(new NotificationRequest(
            Title: title,
            Body: $"The HMRC Tied Oil declaration for {period.Start:yyyy-MM-dd} to {periodEndLabel} is ready to review and submit.",
            Severity: 2,
            Category: "logistics",
            ActionLabel: "Review Declaration",
            ActionUrl: "/private/logistics.html",
            Target: new NotificationTarget(NotificationTargetType.Permission, "ISOPAR_DECL")), ct);

        return new IsoparDeclarationDueCheckResult(Notified: true, PeriodEnd: periodEndLabel);
    }
}
