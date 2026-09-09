using Dapper;
using Microsoft.Data.SqlClient;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Finance;

/// <summary>
/// GL Account Groups (acct.FinanceGlGroups/FinanceGlGroupAccounts, SQL-only)
/// + the three SAP costing proxies backing Material Costing/Actual Costs/
/// Profit Center Data. Port of routes/finance.js + the /cost-sheet,
/// /costing/period-balance, /costing/profit-center handlers from
/// routes/sap.js (moved here since they're genuinely Finance-only).
/// </summary>
internal static class FinanceHelper
{
    // A genuinely new gate, not a split of an existing legacy code — Node's
    // GL-group writes (and the three costing proxies) currently have no
    // permission check at all beyond requireLogin, a real gap flagged by
    // research. Read access stays Dept:finance-only (still a tightening
    // over Node's "any logged-in user of any department"); this code adds
    // one further gate on top for the two destructive/mutating actions.
    internal const string FnGlGroupsManage = "FIN_GL_GROUPS_MANAGE";

    internal static async Task<IReadOnlyList<GlGroupRow>> ListGlGroupsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var groups = (await connection.QueryAsync<(int GroupID, string GroupLabel)>(new CommandDefinition(
            "SELECT GroupID, GroupLabel FROM acct.FinanceGlGroups ORDER BY SortOrder, GroupLabel", cancellationToken: ct))).ToList();
        var accounts = (await connection.QueryAsync<(int GroupID, string GlAccount)>(new CommandDefinition(
            "SELECT GroupID, GlAccount FROM acct.FinanceGlGroupAccounts ORDER BY GroupID, SortOrder, GlAccount", cancellationToken: ct))).ToList();

        var accountsByGroup = accounts.GroupBy(a => a.GroupID).ToDictionary(g => g.Key, g => g.Select(a => a.GlAccount).ToList());

        return groups.Select(g => new GlGroupRow(g.GroupID, g.GroupLabel, accountsByGroup.GetValueOrDefault(g.GroupID) ?? [])).ToArray();
    }

    internal static async Task<int> CreateGlGroupAsync(INexusOperationsDb db, GlGroupSaveRequest body, CancellationToken ct)
    {
        var label = body.Label?.Trim();
        if (string.IsNullOrWhiteSpace(label))
        {
            throw new NexusValidationException("label is required.");
        }

        using var connection = await db.CreateConnectionAsync(ct);
        var groupId = await connection.QuerySingleAsync<int>(new CommandDefinition(
            "INSERT INTO acct.FinanceGlGroups (GroupLabel) OUTPUT INSERTED.GroupID VALUES (@label)",
            new { label }, cancellationToken: ct));

        await InsertAccountsAsync(connection, groupId, body.Accounts, ct);
        return groupId;
    }

    internal static async Task UpdateGlGroupAsync(INexusOperationsDb db, int id, GlGroupSaveRequest body, CancellationToken ct)
    {
        var label = body.Label?.Trim();
        if (string.IsNullOrWhiteSpace(label))
        {
            throw new NexusValidationException("label is required.");
        }

        using var connection = await db.CreateConnectionAsync(ct);
        var rowsAffected = await connection.ExecuteAsync(new CommandDefinition(
            "UPDATE acct.FinanceGlGroups SET GroupLabel = @label WHERE GroupID = @id", new { label, id }, cancellationToken: ct));
        if (rowsAffected == 0)
        {
            throw new NexusNotFoundException($"GL group {id} not found.");
        }

        await connection.ExecuteAsync(new CommandDefinition(
            "DELETE FROM acct.FinanceGlGroupAccounts WHERE GroupID = @id", new { id }, cancellationToken: ct));
        await InsertAccountsAsync(connection, id, body.Accounts, ct);
    }

    internal static async Task DeleteGlGroupAsync(INexusOperationsDb db, int id, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rowsAffected = await connection.ExecuteAsync(new CommandDefinition(
            "DELETE FROM acct.FinanceGlGroups WHERE GroupID = @id", new { id }, cancellationToken: ct));
        if (rowsAffected == 0)
        {
            throw new NexusNotFoundException($"GL group {id} not found.");
        }
    }

    private static async Task InsertAccountsAsync(SqlConnection connection, int groupId, List<string>? accounts, CancellationToken ct)
    {
        var sortOrder = 0;
        foreach (var raw in accounts ?? [])
        {
            var account = raw?.Trim();
            if (string.IsNullOrWhiteSpace(account)) continue;

            await connection.ExecuteAsync(new CommandDefinition(
                "INSERT INTO acct.FinanceGlGroupAccounts (GroupID, GlAccount, SortOrder) VALUES (@groupId, @account, @sortOrder)",
                new { groupId, account, sortOrder }, cancellationToken: ct));
            sortOrder++;
        }
    }

    internal static async Task<IReadOnlyList<CostSheetRow>> GetCostSheetAsync(ISapServerClient sap, CostSheetRequest body, int userId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.Date) || body.Materials is not { Count: > 0 })
        {
            throw new NexusValidationException("date and at least one material are required.");
        }

        var rows = await sap.PostAsync<CostSheetRow[]>("api/costing/cost-sheet", body, userId, ct: ct);
        return rows ?? [];
    }

    internal static async Task<IReadOnlyList<PeriodBalanceRow>> GetPeriodBalanceAsync(ISapServerClient sap, PeriodBalanceRequest body, int userId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.FiscalYear) || string.IsNullOrWhiteSpace(body.PeriodFrom)
            || string.IsNullOrWhiteSpace(body.PeriodTo) || body.GlAccounts is not { Count: > 0 })
        {
            throw new NexusValidationException("fiscalYear, periodFrom, periodTo, and at least one GL account are required.");
        }

        var rows = await sap.PostAsync<PeriodBalanceRow[]>("api/costing/period-balance", body, userId, ct: ct);
        return rows ?? [];
    }

    internal static async Task<IReadOnlyList<ProfitCenterRow>> GetProfitCenterAsync(ISapServerClient sap, ProfitCenterRequest body, int userId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.DateFrom) || string.IsNullOrWhiteSpace(body.DateTo) || body.GlAccounts is not { Count: > 0 })
        {
            throw new NexusValidationException("dateFrom, dateTo, and at least one GL account are required.");
        }

        var rows = await sap.PostAsync<ProfitCenterRow[]>("api/costing/profit-center", body, userId, ct: ct);
        return rows ?? [];
    }
}
