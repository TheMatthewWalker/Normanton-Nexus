using Dapper;
using Microsoft.Data.SqlClient;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Sales;

/// <summary>
/// Sales department logic — port of routes/sales.js (Customer Standard
/// Instructions, SQL-only) and routes/salessap.js (Schedule Agreement
/// Waterfall, proxies to SapServer's own SalesController — see
/// SapServer/Controllers/SalesController.cs, already exists, not
/// modified). See Helpers/ProductionSchedule/ for the shared
/// Production Schedule tile, which lives on this page too but isn't
/// Sales-specific logic.
/// </summary>
internal static class SalesHelper
{
    // Replaces the legacy SALES_SUPERVISOR (which also covered the shared
    // Production Schedule edit — see ProductionScheduleHelper.FnScheduleEdit
    // for that split) for the one tile that's genuinely Sales-only.
    internal const string FnCustomerInstructions = "SALES_CUSTOMER_INSTRUCTIONS";

    private const int MaxCustomerLength = 10;
    private const int MaxCustomerNameLength = 35;
    private const int MaxInstructionsLength = 1000;

    internal static async Task<IReadOnlyList<CustomerInstructionRow>> ListCustomerInstructionsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        const string sql = """
            SELECT Customer, CustomerName, Instructions, LastUpdatedUtc, UpdatedByUsername
            FROM log.CustomerStandardInstructions
            ORDER BY Customer
            """;

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<CustomerInstructionRow>(new CommandDefinition(sql, cancellationToken: ct));
        return rows.ToArray();
    }

    internal static async Task SaveCustomerInstructionAsync(
        INexusOperationsDb db, string customer, CustomerInstructionSaveRequest body, string? username, CancellationToken ct)
    {
        customer = customer.Trim();
        if (string.IsNullOrWhiteSpace(customer))
        {
            throw new NexusValidationException("customer is required.");
        }
        if (string.IsNullOrWhiteSpace(body.Instructions))
        {
            throw new NexusValidationException("instructions is required.");
        }

        using var connection = await db.CreateConnectionAsync(ct);
        await UpsertAsync(connection, customer, body.CustomerName, body.Instructions, username, ct);
    }

    private static async Task<bool> UpsertAsync(
        SqlConnection connection, string customer, string? customerName, string instructions, string? username, CancellationToken ct)
    {
        var exists = await connection.QuerySingleOrDefaultAsync<int?>(new CommandDefinition(
            "SELECT 1 FROM log.CustomerStandardInstructions WHERE Customer = @customer",
            new { customer }, cancellationToken: ct)) is not null;

        if (exists)
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE log.CustomerStandardInstructions
                SET CustomerName = @customerName, Instructions = @instructions, LastUpdatedUtc = GETUTCDATE(), UpdatedByUsername = @username
                WHERE Customer = @customer
                """, new { customer, customerName, instructions, username }, cancellationToken: ct));
        }
        else
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO log.CustomerStandardInstructions (Customer, CustomerName, Instructions, LastUpdatedUtc, UpdatedByUsername)
                VALUES (@customer, @customerName, @instructions, GETUTCDATE(), @username)
                """, new { customer, customerName, instructions, username }, cancellationToken: ct));
        }

        return exists;
    }

    internal static async Task DeleteCustomerInstructionAsync(INexusOperationsDb db, string customer, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "DELETE FROM log.CustomerStandardInstructions WHERE Customer = @customer",
            new { customer = customer.Trim() }, cancellationToken: ct));
    }

    /// <summary>
    /// Continue-on-error per row, matching routes/sales.js's bulk-import loop
    /// exactly: a validation failure or a per-row SQL exception is recorded
    /// in Failed and the loop moves on, rather than aborting the whole batch.
    /// </summary>
    internal static async Task<BulkImportResult> BulkImportCustomerInstructionsAsync(
        INexusOperationsDb db, BulkImportCustomerInstructionsRequest body, string? username, CancellationToken ct)
    {
        var created = 0;
        var updated = 0;
        var failed = new List<BulkImportFailure>();

        using var connection = await db.CreateConnectionAsync(ct);

        foreach (var row in body.Rows)
        {
            var customer = row.Customer?.Trim() ?? "";
            if (customer.Length == 0)
            {
                failed.Add(new BulkImportFailure(customer, "Missing account code."));
                continue;
            }
            if (customer.Length > MaxCustomerLength)
            {
                failed.Add(new BulkImportFailure(customer, "Account code is longer than 10 characters."));
                continue;
            }

            var instructions = row.Instructions?.Trim() ?? "";
            if (instructions.Length == 0)
            {
                failed.Add(new BulkImportFailure(customer, "Missing instructions text."));
                continue;
            }
            if (instructions.Length > MaxInstructionsLength)
            {
                failed.Add(new BulkImportFailure(customer, $"Instructions text too long ({instructions.Length} of max {MaxInstructionsLength} characters)."));
                continue;
            }

            var customerName = row.CustomerName?.Length > MaxCustomerNameLength
                ? row.CustomerName[..MaxCustomerNameLength]
                : row.CustomerName;

            try
            {
                var wasUpdate = await UpsertAsync(connection, customer, customerName, instructions, username, ct);
                if (wasUpdate) updated++; else created++;
            }
            catch (Exception ex)
            {
                failed.Add(new BulkImportFailure(customer, ex.Message));
            }
        }

        return new BulkImportResult(created, updated, failed);
    }

    internal static async Task<IReadOnlyList<ScheduleWaterfallRow>> GetScheduleWaterfallAsync(
        ISapServerClient sap, ScheduleWaterfallQuery query, int userId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(query.SalesOrg)
            || query.ShipToParties is not { Count: > 0 }
            || string.IsNullOrWhiteSpace(query.ScheduleDateFrom)
            || string.IsNullOrWhiteSpace(query.ScheduleDateTo))
        {
            throw new NexusValidationException("salesOrg, shipToParties, scheduleDateFrom, and scheduleDateTo are required.");
        }

        var request = new ScheduleWaterfallRequest(
            SalesOrg: query.SalesOrg,
            ShipToParties: query.ShipToParties,
            Materials: query.Materials ?? [],
            IncludeForecast: query.IncludeForecast,
            IncludeJit: query.IncludeJit,
            IdocCreatedAfter: DateTime.TryParse(query.IdocCreatedAfter, out var idocDate) ? idocDate : null,
            ScheduleDateFrom: DateTime.Parse(query.ScheduleDateFrom),
            ScheduleDateTo: DateTime.Parse(query.ScheduleDateTo),
            IncludeZeroQty: query.IncludeZeroQty);

        var rows = await sap.PostAsync<ScheduleWaterfallRow[]>("api/sales/schedule-waterfall", request, userId, ct: ct);
        return rows ?? [];
    }
}
