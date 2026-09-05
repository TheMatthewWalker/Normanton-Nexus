using System.Text.RegularExpressions;
using Dapper;
using Microsoft.Data.SqlClient;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Production;

/// <summary>Billet Staging — see BilletStagingModels.cs's header comment for scope/context.</summary>
internal static partial class BilletStagingHelper
{
    private const int MinAgeHours = 24;

    // Age in hours since the parent mix completed, and the age-bucket label
    // used by both the queue and the search picker — kept as raw SQL
    // fragments (not computed in C#) to match Node's own MX_AGE_HOURS_SQL/
    // MX_AGE_BUCKET_SQL exactly, since both are ORDER-BY/WHERE-eligible
    // expressions evaluated inside the query, not post-processed.
    private const string AgeHoursSql = "(DATEDIFF(MINUTE, m.CompletedAt, GETDATE()) / 60.0)";
    private const string AgeBucketSql = $"""
        CASE
            WHEN {AgeHoursSql} > 96 THEN N'expired'
            WHEN {AgeHoursSql} > 72 THEN N'72-96'
            WHEN {AgeHoursSql} > 48 THEN N'48-72'
            WHEN {AgeHoursSql} > 24 THEN N'24-48'
            ELSE N'0-24'
        END
        """;

    internal static async Task<IReadOnlyList<BilletStagingQueueRow>> GetQueueAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<BilletStagingQueueRow>(new CommandDefinition($"""
            SELECT t.TubID AS TubId, t.MixingID AS MixingId, t.TubSeq, t.SupplierTubNo, t.TubWeightKG AS TubWeightKg,
                   m.Material, m.MixCode, m.MixRef, m.CompletedAt,
                   {AgeHoursSql} AS AgeHours, {AgeBucketSql} AS Bucket
            FROM prod.MixingTubs t
            JOIN prod.Mixing m ON m.MixingID = t.MixingID
            WHERE t.IsStaged = 0 AND t.IsScrapped = 0 AND t.SAPSuccess = 1
              AND m.IsReversed = 0 AND m.Status NOT IN (5, 6)
              AND {AgeHoursSql} <= 96
            ORDER BY m.CompletedAt ASC
            """, cancellationToken: ct));
        return rows.ToArray();
    }

    private sealed record TubForStaging(
        int MixingId, int TubSeq, decimal TubWeightKg, bool IsStaged, bool IsScrapped, DateTime? ExpiryOverrideAt,
        string? MixRef, bool IsReversed, int Status, decimal AgeHours, decimal ReturnedKg);

    /// <summary>
    /// Shared staging logic — every path that can stage a tub (manual stage
    /// button and scan-a-ticket) goes through this, so every guard
    /// (including the 24h minimum) is enforced identically everywhere,
    /// matching Node's own single stageTub() helper exactly.
    /// </summary>
    private static async Task<StageTubResult> StageTubAsync(SqlConnection connection, int userId, int tubId, CancellationToken ct)
    {
        var tub = await connection.QuerySingleOrDefaultAsync<TubForStaging?>(new CommandDefinition($"""
            SELECT t.MixingID AS MixingId, t.TubSeq, t.TubWeightKG AS TubWeightKg, t.IsStaged, t.IsScrapped, t.ExpiryOverrideAt,
                   m.MixRef, m.IsReversed, m.Status,
                   {AgeHoursSql} AS AgeHours,
                   (SELECT ISNULL(SUM(QuantityKG), 0) FROM prod.MixingTubReturns WHERE TubID = t.TubID) AS ReturnedKg
            FROM prod.MixingTubs t JOIN prod.Mixing m ON m.MixingID = t.MixingID
            WHERE t.TubID = @tubId
            """, new { tubId }, cancellationToken: ct));

        if (tub is null) throw new NexusNotFoundException("Tub not found.");
        if (tub.IsScrapped) throw new NexusConflictException("This tub has been scrapped and cannot be staged.");
        if (tub.IsReversed || tub.Status is 5 or 6) throw new NexusConflictException("The parent mix has been reversed or cancelled.");
        if (tub.IsStaged) throw new NexusConflictException("This tub is already staged into Billet.");
        if (tub.AgeHours < MinAgeHours && tub.ExpiryOverrideAt is null)
        {
            var remaining = Math.Round((MinAgeHours - tub.AgeHours) * 10) / 10;
            throw new NexusConflictException(
                $"This tub is only {tub.AgeHours:F1}h old — mixes need at least {MinAgeHours}h before they can be staged (available in {remaining}h).");
        }
        if (tub.AgeHours > 96 && tub.ExpiryOverrideAt is null)
        {
            throw new NexusConflictException("This tub is expired (>96h) and requires supervisor review — approve scrap or override expiry from the Expired Mix Batches queue.");
        }

        var balance = Math.Round((tub.TubWeightKg - tub.ReturnedKg) * 1000) / 1000;
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE prod.MixingTubs
            SET IsStaged = 1, StagedAt = GETDATE(), ConditioningTimeHours = @ageHours, StagedByUserID = @userId, StagedQuantityKG = @balance
            WHERE TubID = @tubId
            """, new { tubId, userId, ageHours = tub.AgeHours, balance }, cancellationToken: ct));

        // EventType is constrained to a fixed enum with no "STAGED" value —
        // NOTE is used, same as every other event kind the enum doesn't
        // cover, with the specific meaning kept in the message text itself.
        await ProductionEventLogHelper.WriteEventAsync(connection, "MX", tub.MixingId, "NOTE",
            $"Tub {tubId} staged into Billet ({tub.AgeHours:F1}h after production)", 0, userId, ct);

        var mixRef = tub.MixRef ?? $"MX-{tub.MixingId:D8}";
        return new StageTubResult(tubId, mixRef, tub.TubSeq, balance);
    }

    internal static async Task<StageTubResult> StageAsync(INexusOperationsDb db, int tubId, int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await StageTubAsync(connection, userId, tubId, ct);
    }

    [GeneratedRegex(@"^MX-(\d+)-T(\d+)$", RegexOptions.IgnoreCase)]
    private static partial Regex StageByRefPattern();

    internal static async Task<StageTubResult> StageByRefAsync(INexusOperationsDb db, StageByRefRequest body, int userId, CancellationToken ct)
    {
        var raw = (body.Ref ?? "").Trim();
        var match = StageByRefPattern().Match(raw);
        if (!match.Success)
        {
            throw new NexusValidationException($"Unrecognised ticket format: \"{raw}\". Expected something like MX-00000064-T1.");
        }

        var mixingId = int.Parse(match.Groups[1].Value);
        var tubSeq = int.Parse(match.Groups[2].Value);

        using var connection = await db.CreateConnectionAsync(ct);
        var tubId = await connection.QuerySingleOrDefaultAsync<int?>(new CommandDefinition(
            "SELECT TubID FROM prod.MixingTubs WHERE MixingID = @mixingId AND TubSeq = @tubSeq",
            new { mixingId, tubSeq }, cancellationToken: ct));
        if (tubId is null)
        {
            throw new NexusNotFoundException($"Ticket not recognised — no tub matches {raw}.");
        }

        return await StageTubAsync(connection, userId, tubId.Value, ct);
    }

    private sealed record TubForReturn(int MixingId, bool IsStaged, decimal StagedQuantityKg);

    internal static async Task<ReturnToConditioningResult> ReturnToConditioningAsync(INexusOperationsDb db, int tubId, ReturnToConditioningRequest body, int userId, CancellationToken ct)
    {
        if (body.QuantityKg <= 0)
        {
            throw new NexusValidationException("quantityKg must be greater than 0.");
        }
        var notes = body.Notes?.Length > 500 ? body.Notes[..500] : body.Notes;

        using var connection = await db.CreateConnectionAsync(ct);
        var tub = await connection.QuerySingleOrDefaultAsync<TubForReturn?>(new CommandDefinition(
            "SELECT MixingID AS MixingId, IsStaged, StagedQuantityKG AS StagedQuantityKg FROM prod.MixingTubs WHERE TubID = @tubId",
            new { tubId }, cancellationToken: ct));
        if (tub is null) throw new NexusNotFoundException("Tub not found.");
        if (!tub.IsStaged) throw new NexusConflictException("This tub is not currently staged.");
        if (body.QuantityKg > tub.StagedQuantityKg)
        {
            throw new NexusConflictException($"Cannot return {body.QuantityKg} KG — only {tub.StagedQuantityKg} KG is currently staged.");
        }

        await connection.ExecuteAsync(new CommandDefinition(
            "INSERT INTO prod.MixingTubReturns (TubID, QuantityKG, ReturnedByUserID, Notes) VALUES (@tubId, @quantityKg, @userId, @notes)",
            new { tubId, quantityKg = body.QuantityKg, userId, notes }, cancellationToken: ct));

        var newBalance = Math.Round((tub.StagedQuantityKg - body.QuantityKg) * 1000) / 1000;
        var stillStaged = newBalance > 0;
        await connection.ExecuteAsync(new CommandDefinition(
            "UPDATE prod.MixingTubs SET StagedQuantityKG = @newBalance, IsStaged = @stillStaged WHERE TubID = @tubId",
            new { tubId, newBalance, stillStaged }, cancellationToken: ct));

        await ProductionEventLogHelper.WriteEventAsync(connection, "MX", tub.MixingId, "NOTE",
            $"{body.QuantityKg} KG returned to Conditioning from tub {tubId}{(notes is { Length: > 0 } ? $" — {notes}" : "")}", 0, userId, ct);

        return new ReturnToConditioningResult(tubId, newBalance, stillStaged);
    }

    internal static async Task<IReadOnlyList<TubSearchRow>> SearchTubsAsync(INexusOperationsDb db, string? search, CancellationToken ct)
    {
        var like = string.IsNullOrWhiteSpace(search) ? null : $"%{search.Trim()}%";
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<TubSearchRow>(new CommandDefinition($"""
            SELECT TOP 50
                   t.TubID AS TubId, t.MixingID AS MixingId, t.TubSeq, t.SupplierTubNo, t.TubWeightKG AS TubWeightKg,
                   t.IsStaged, t.StagedQuantityKG AS StagedQuantityKg, t.ConditioningTimeHours, t.IsScrapped,
                   m.Material, m.MixCode, m.MixRef, m.CompletedAt,
                   {AgeHoursSql} AS AgeHours, {AgeBucketSql} AS Bucket
            FROM prod.MixingTubs t JOIN prod.Mixing m ON m.MixingID = t.MixingID
            WHERE m.IsReversed = 0 AND t.SAPSuccess = 1
              AND (@like IS NULL OR m.MixRef LIKE @like OR m.MixCode LIKE @like OR m.Material LIKE @like OR t.SupplierTubNo LIKE @like)
            ORDER BY m.CompletedAt DESC
            """, new { like }, cancellationToken: ct));
        return rows.ToArray();
    }
}
