using Dapper;
using Microsoft.Data.SqlClient;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;

namespace NormantonNexus.Helpers.Production;

/// <summary>
/// Shared SAP-response-parsing and profit-centre-validation logic used
/// across every Production entry/completion cluster — port of the
/// corresponding module-level helpers in routes/productionnexus.js
/// (parseSapBackflush, assertProfitCentre, the PROFIT_CENTRES table).
/// </summary>
internal static class ProductionSapHelpers
{
    /// <summary>Each process may only post materials belonging to its own SAP profit centre(s) — mirrors Node's PROFIT_CENTRES table exactly. FW has no material of its own (inspects an Ewald batch), so it's deliberately absent, same as Node.</summary>
    private static readonly Dictionary<string, string[]> ProfitCentres = new(StringComparer.OrdinalIgnoreCase)
    {
        ["MX"] = ["2000"],
        ["EX"] = ["2001", "2021"],
        ["CO"] = ["2002", "2022"],
        ["BR"] = ["2003"],
        ["DR"] = ["2004"],
        ["TW"] = ["2005"],
        ["CL"] = ["2006"],
        ["EW"] = ["2007"],
        ["HA"] = ["2009"],
    };

    /// <summary>
    /// Throws 400 when the material's profit centre doesn't match the
    /// process, 502 when SAP can't confirm it — fails closed, matching
    /// Node exactly (posting a wrong material into SAP is exactly what
    /// this check exists to prevent, so no confirmation = no post).
    /// </summary>
    internal static async Task AssertProfitCentreAsync(ISapServerClient sap, string processCode, string material, int userId, CancellationToken ct)
    {
        if (!ProfitCentres.TryGetValue(processCode, out var allowed)) return;

        string? raw;
        try
        {
            raw = await sap.GetAsync<string>("api/production/check-profit-centre", userId, new ProfitCentreRequest(material), ct: ct);
        }
        catch (Exception ex)
        {
            throw new NexusBadGatewayException($"Unable to verify profit centre for {material}: {ex.Message}");
        }

        // MARC-PRCTR comes back zero-padded to 10 chars.
        var prctr = (raw ?? "").Trim().TrimStart('0');
        if (!allowed.Contains(prctr))
        {
            throw new NexusValidationException(
                $"Material {material} belongs to profit centre {(prctr.Length > 0 ? prctr : "(none)")} — not valid for {processCode} (expects {string.Join(" or ", allowed)}).");
        }
    }

    /// <summary>
    /// Validates SapServer's ZF40N backflush result — a real "S"/"RM"/190-or-191
    /// message means the backflush was actually accepted by SAP; anything
    /// else (including a genuine ABAP error) throws. Mirrors Node's
    /// parseSapBackflush exactly, including the 190/191 special case (190 =
    /// posted but no component consumption — still a real success, flagged
    /// separately for data review by the caller, not treated as a failure).
    /// </summary>
    internal static string ParseSapBackflush(BdcResponse response)
    {
        if (response.Type == "S" && response.MessageClass == "RM" && response.MessageNumber is "190" or "191")
        {
            return response.DocumentNumber;
        }
        throw new NexusBadGatewayException(response.Message is { Length: > 0 } msg ? msg : $"SAP backflush rejected: {response.Type} {response.MessageClass} {response.MessageNumber}");
    }

    /// <summary>Logs a 190 (no component consumption) to prod.BackflushAlerts for data review — mirrors Node's logBackflushAlert exactly.</summary>
    internal static async Task LogBackflushAlertAsync(SqlConnection connection, string processCode, int recordId, string? batchRef, string? materialDocument, string messageNumber, string? messageText, CancellationToken ct)
    {
        await connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO prod.BackflushAlerts (ProcessCode, ProcessRecordID, BatchRef, MaterialDocument, MessageNumber, MessageText, AlertType)
            VALUES (@processCode, @recordId, @batchRef, @materialDocument, @messageNumber, @messageText, 'NO_COMPONENT_CONSUMPTION')
            """, new { processCode, recordId, batchRef, materialDocument, messageNumber, messageText = messageText ?? "" }, cancellationToken: ct));
    }

    /// <summary>Mirrors Node's currentShiftID() — the shift a batch created "now" is attributed to when no shift is explicitly chosen.</summary>
    internal static int CurrentShiftId()
    {
        var hour = DateTime.Now.Hour;
        if (hour is >= 6 and < 14) return 1; // DAYS
        if (hour is >= 14 and < 22) return 2; // AFTERS
        return 3; // NIGHTS
    }
}
